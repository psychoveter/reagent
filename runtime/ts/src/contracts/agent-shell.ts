/**
 * AgentShell — R1 ontology.
 *
 * The primary runtime object for one agent identity.
 * Owns persistent $self, the active/completed run registry,
 * mailbox/session identity, and an optional attached AgentBehavior.
 *
 * Shell lifecycle: detached <-> attached.
 *   - detached: shell exists as mailbox/session container, no executable behavior
 *   - attached: behavior is present, shell may participate in new runs
 *
 * AgentRecord is projected from the shell via toRecord().
 */

import type { MessageEnvelope, ProtocolTrigger } from "./types.js";
import type { AgentBehavior } from "./agent-behavior.js";
import type { RoleRunStatus } from "./protocol-run.js";

// ── AgentShellStatus ─────────────────────────────────────────────────

export type AgentShellStatus = "detached" | "attached";

export type ShellStatusChangeCallback = (agentName: string, newStatus: AgentShellStatus) => void;

// ── AgentRecordDTO ───────────────────────────────────────────────────

export interface AgentRecordDTO {
  name: string;
  role: string;
  nodeId: string;
  status: AgentShellStatus;
  heartbeatAt?: number;
  capabilities?: string[];
  metadata: Record<string, unknown>;
}

// ── RoleRunResult ────────────────────────────────────────────────────

export interface RoleRunResult {
  instanceId: string;
  protocolName: string;
  roleName: string;
  status: RoleRunStatus;
  returnValue?: unknown;
}

// ── RoleRun (forward reference for shell interface) ──────────────────

export interface RoleRunHandle {
  readonly instanceId: string;
  readonly protocolName: string;
  readonly roleName: string;
  readonly agentName: string;
  readonly status: RoleRunStatus;

  dispatchMessage(env: MessageEnvelope): void;
  run(): Promise<void>;
  getReturnValue(): { has: boolean; value: unknown };
}

// ── AgentShell ───────────────────────────────────────────────────────

export interface AgentShell {
  readonly name: string;
  readonly role: string;
  readonly status: AgentShellStatus;

  start(): Promise<void>;
  stop(): Promise<void>;

  attachBehavior(behavior: AgentBehavior): void;
  detachBehavior(): void;
  hasBehavior(): boolean;

  getSelf(): Record<string, unknown>;
  getActiveRuns(): Map<string, RoleRunHandle>;
  getCompletedRuns(): RoleRunResult[];

  triggerProtocol(trigger: ProtocolTrigger): void;
  dispatchMessage(env: MessageEnvelope): void;

  onRunCompleted(cb: (run: RoleRunHandle, status: RoleRunStatus) => void): void;
  setStatusChangeCallback(cb: ShellStatusChangeCallback | undefined): void;
  toRecord(nodeId: string): AgentRecordDTO;
}
