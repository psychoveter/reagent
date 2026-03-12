/**
 * Protocol run correlation types — R1 ontology.
 *
 * ProtocolRunRef is the mandatory distributed correlation identity.
 * ProtocolRunTracker is an optional aggregation extension point.
 * RoleRunIdentity locates one local role execution inside one distributed run.
 */

// ── ProtocolRunRef ───────────────────────────────────────────────────

export interface ProtocolRunRef {
  readonly instanceId: string;
  readonly protocolName: string;
}

// ── ProtocolRunSnapshot (used by tracker) ────────────────────────────

export interface ProtocolRunSnapshot {
  readonly ref: ProtocolRunRef;
  readonly roles: ReadonlyMap<string, { agentName: string; status: RoleRunStatus }>;
  readonly startedAt: number;
  readonly completedAt?: number;
}

export type RoleRunStatus = "idle" | "running" | "completed" | "failed";

// ── ProtocolRunTracker ───────────────────────────────────────────────

export interface ProtocolRunTracker {
  getRun(ref: ProtocolRunRef): ProtocolRunSnapshot | undefined;
  onRunUpdated(cb: (snapshot: ProtocolRunSnapshot) => void): void;
  cancelRun(ref: ProtocolRunRef): Promise<void>;
}

// ── RoleRunIdentity ──────────────────────────────────────────────────

export interface RoleRunIdentity extends ProtocolRunRef {
  readonly roleName: string;
  readonly agentName: string;
}
