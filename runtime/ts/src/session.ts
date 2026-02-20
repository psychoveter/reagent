/**
 * Session management — one session per .rg program execution/debug context.
 */

import { randomUUID } from "node:crypto";
import type { IRGraph, RoleIR, TraceEvent } from "./types.js";
import type { ReagentController } from "./reagent-controller.js";

export interface SourceMapEntry {
  stateId: string;
  protocolName: string;
  role: string;
  file: string;
  line: number;
  column: number;
}

export interface SourceMap {
  entries: SourceMapEntry[];
}

export interface CompiledArtifacts {
  irGraphs: Map<string, IRGraph>;
  roleIRs: Map<string, RoleIR>;
  deployment: Record<string, unknown>;
  sourceMap: SourceMap;
}

export type SessionStatus = "created" | "deploying" | "running" | "paused" | "completed" | "failed";

export class Session {
  readonly sessionId: string;
  rgSource: string;
  fileName: string;
  compiled: CompiledArtifacts | null = null;
  rc: ReagentController | null = null;
  traces: TraceEvent[] = [];
  status: SessionStatus = "created";
  completedCount = 0;
  expectedCompletions = 0;

  private onStatusChange: ((session: Session) => void) | null = null;
  private onTrace: ((event: TraceEvent) => void) | null = null;

  constructor(rgSource: string, fileName: string) {
    this.sessionId = randomUUID();
    this.rgSource = rgSource;
    this.fileName = fileName;
  }

  setOnStatusChange(cb: (session: Session) => void): void {
    this.onStatusChange = cb;
  }

  setOnTrace(cb: (event: TraceEvent) => void): void {
    this.onTrace = cb;
  }

  pushTrace(event: TraceEvent): void {
    this.traces.push(event);
    this.onTrace?.(event);
  }

  setStatus(status: SessionStatus): void {
    this.status = status;
    this.onStatusChange?.(this);
  }

  recordCompletion(): void {
    this.completedCount++;
    if (this.completedCount >= this.expectedCompletions && this.status === "running") {
      this.setStatus("completed");
    }
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(rgSource: string, fileName: string): Session {
    const session = new Session(rgSource, fileName);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.rc) {
      await session.rc.stop();
    }
    this.sessions.delete(sessionId);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }
}
