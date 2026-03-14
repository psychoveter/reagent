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

export type RoleRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ProtocolRunStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned"
  | "adopting";

export type ProcessRelationKind =
  | "root"
  | "invoke"
  | "async_invoke";

export type SupervisionStrategy =
  | "scoped"
  | "one-for-one"
  | "all-for-one"
  | "detached";

export interface ProtocolRunRoleStatus {
  readonly agentName: string;
  readonly roleName: string;
  readonly nodeId?: string;
  readonly status: RoleRunStatus;
  readonly updatedAt: number;
  readonly lossDetectedAt?: number;
}

export interface SpawnOwnershipRecord {
  readonly agentName: string;
  readonly roleName: string;
  readonly bindAs?: string;
  readonly persistent: boolean;
  readonly createdAt: number;
}

export interface ParticipantLossRecord {
  readonly roleName: string;
  readonly previousAgentName: string;
  readonly detectedByNodeId: string;
  readonly detectedAt: number;
  readonly reason: string;
  readonly replacementAgentName?: string;
}

export interface ProtocolCancellationState {
  readonly requestedAt: number;
  readonly requestedByNodeId: string;
  readonly reason?: string;
  readonly acknowledgedRoleNames: readonly string[];
  readonly acknowledgedNodeIds: readonly string[];
}

export interface ProtocolRunRecord extends ProtocolRunRef {
  readonly status: ProtocolRunStatus;
  readonly homeNodeId: string;
  readonly relationKind: ProcessRelationKind;
  readonly supervisionStrategy: SupervisionStrategy;
  readonly rootInstanceId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly parentInstanceId?: string;
  readonly parentProtocolName?: string;
  readonly ownerAgentName?: string;
  readonly ownerRoleName?: string;
  readonly failureReason?: string;
  readonly adoptedByNodeId?: string;
  readonly orphanedAt?: number;
  readonly cancellation?: ProtocolCancellationState;
  readonly participantLosses?: readonly ParticipantLossRecord[];
  /** Current runtime model: one live owner entry per role name. */
  readonly roles: Readonly<Record<string, ProtocolRunRoleStatus>>;
  readonly childInstanceIds: readonly string[];
  readonly spawnedAgents: readonly SpawnOwnershipRecord[];
}

// ── ProtocolRunSnapshot (used by tracker) ────────────────────────────

export interface ProtocolRunSnapshot {
  readonly ref: ProtocolRunRef;
  readonly roles: ReadonlyMap<string, { agentName: string; status: RoleRunStatus }>;
  readonly startedAt: number;
  readonly completedAt?: number;
}

// ── ProtocolRunTracker ───────────────────────────────────────────────

export interface ProtocolRunTracker {
  getRun(ref: ProtocolRunRef): ProtocolRunSnapshot | undefined;
  getRunRecord(ref: ProtocolRunRef): Promise<ProtocolRunRecord | undefined>;
  listRuns(): Promise<ProtocolRunRecord[]>;
  onRunUpdated(cb: (snapshot: ProtocolRunSnapshot) => void): void;
  cancelRun(ref: ProtocolRunRef): Promise<void>;
}

// ── RoleRunIdentity ──────────────────────────────────────────────────

export interface RoleRunIdentity extends ProtocolRunRef {
  readonly roleName: string;
  readonly agentName: string;
}

export function isTerminalRoleRunStatus(status: RoleRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isTerminalProtocolRunStatus(status: ProtocolRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
