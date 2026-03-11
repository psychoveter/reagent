/**
 * CronAgent — system agent that parses cron expressions and emits
 * cron.tick events to TriggerMatcher via the LocalEventBus.
 *
 * Supports standard 5-field cron: minute hour dom month dow
 * Plus common aliases: @hourly, @daily, @weekly, @monthly
 */

import { LocalEventBus } from "../controller/local-event-bus.js";
import type { LeaderElection } from "../cluster/leader-election.js";

// ── Cron expression parser ──────────────────────────────────────────

export interface CronField {
  values: Set<number>;
}

const ALIASES: Record<string, string> = {
  "@yearly":  "0 0 1 1 *",
  "@annually":"0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly":  "0 0 * * 0",
  "@daily":   "0 0 * * *",
  "@midnight":"0 0 * * *",
  "@hourly":  "0 * * * *",
};

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week (0=Sun)
];

export function parseCronField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else {
      values.add(parseInt(range, 10));
    }
  }

  return { values };
}

export function parseCronExpression(expr: string): CronField[] {
  const resolved = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = resolved.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" — expected 5 fields, got ${parts.length}`);
  }
  return parts.map((p, i) => parseCronField(p, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
}

export function cronMatchesDate(fields: CronField[], date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  return (
    fields[0].values.has(minute) &&
    fields[1].values.has(hour) &&
    fields[2].values.has(dom) &&
    fields[3].values.has(month) &&
    fields[4].values.has(dow)
  );
}

// ── CronAgent ───────────────────────────────────────────────────────

export interface CronSchedule {
  id: string;
  cronExpr: string;
  fields: CronField[];
  protocolName: string;
  topic: string;
  runIndex: number;
}

/**
 * Find the next date after `after` that matches the given cron fields.
 * Scans minute-by-minute up to ~48h ahead. Returns null if none found.
 */
export function nextCronFire(fields: CronField[], after: Date): Date | null {
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = after.getTime() + 48 * 60 * 60 * 1000;
  while (cursor.getTime() < limit) {
    if (cronMatchesDate(fields, cursor)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export class CronAgent {
  private schedules: CronSchedule[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMinute = -1;
  private bus: LocalEventBus;
  private leaderElection: LeaderElection | null = null;

  constructor(bus: LocalEventBus, leaderElection?: LeaderElection) {
    this.bus = bus;
    this.leaderElection = leaderElection ?? null;
  }

  addSchedule(protocolName: string, cronExpr: string): string {
    const id = `cron:${protocolName}:${cronExpr}`;
    const fields = parseCronExpression(cronExpr);
    const topic = `cron.tick.${protocolName}`;
    this.schedules.push({ id, cronExpr, fields, protocolName, topic, runIndex: 0 });
    return id;
  }

  removeSchedule(id: string): void {
    this.schedules = this.schedules.filter(s => s.id !== id);
  }

  async start(intervalMs = 15_000): Promise<void> {
    if (this.timer) return;
    if (this.leaderElection) {
      await this.leaderElection.start();
    }
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.leaderElection) {
      await this.leaderElection.stop();
    }
  }

  getSchedules(): CronSchedule[] {
    return [...this.schedules];
  }

  /** Called every tick interval; fires events only once per matched minute.
   *  When leader election is configured, only the leader fires events. */
  tick(now?: Date): void {
    if (this.leaderElection && !this.leaderElection.isLeader) return;

    const date = now ?? new Date();
    const minuteKey = Math.floor(date.getTime() / 60_000);
    if (minuteKey === this.lastTickMinute) return;
    this.lastTickMinute = minuteKey;

    for (const schedule of this.schedules) {
      if (cronMatchesDate(schedule.fields, date)) {
        schedule.runIndex++;
        const next = nextCronFire(schedule.fields, date);
        this.bus.publish(schedule.topic, {
          topic: schedule.topic,
          payload: {
            runIndex: schedule.runIndex,
            firedAt: date.toISOString(),
            nextFireAt: next?.toISOString() ?? null,
            cronExpr: schedule.cronExpr,
            protocolName: schedule.protocolName,
          },
          source: { agent: "system:cron", instanceId: schedule.id },
          ts: date.getTime(),
        });
      }
    }
  }
}
