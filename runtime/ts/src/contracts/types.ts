import type { RoleBindingMap, LegacyRoleBindingMap } from "../controller/role-bindings.js";

/**
 * Runtime type definitions — mirrors the types from @reagent/lang IR and shared protocol.
 *
 * These are kept in sync with:
 *   - lang/src/ir.ts (IRGraph, AgentIR)
 *   - runtime/shared/protocol.ts (MessageEnvelope, TraceEvent, etc.)
 *
 * We duplicate instead of cross-project import to avoid TS rootDir issues.
 */

// ── From lang/src/ast.ts ────────────────────────────────────────────

export type LangTag = "ts" | "js" | "py" | "kt";
export type ArrowKind = "-->" | "->" | "->>" | "-->>";
export type DurationUnit = "ms" | "s" | "m" | "h";
export type Duration = { value: number; unit: DurationUnit; loc?: unknown };
export type AgentEventKind =
  | "protocolStarted"
  | "protocolCompleted"
  | "protocolFailed"
  | "protocolEvent";

// ── Fingerprints & Versioning (M8a) ─────────────────────────────────

export type ProtocolFingerprint = {
  structureHash: string;
  schemaHash: string;
  implHash: string;
};

export type RoleFingerprint = {
  playsHash: string;
  behaviorHash: string;
};

export type ProtocolDependency = {
  protocolName: string;
  structureHash: string;
  version: string;
};

// ── From lang/src/ast.ts — Participant modifiers ─────────────────────

export type ParticipantBinding = "static" | "dynamic";
export type ParticipantCardinality = "single" | "many";

// ── From lang/src/ir.ts — Participant IR ─────────────────────────────

export type ParticipantIR = {
  name: string;
  lang: LangTag;
  binding: ParticipantBinding;
  cardinality: ParticipantCardinality;
  initiator: boolean;
};

// ── From lang/src/ir.ts — Resolve Policy IR ──────────────────────────

export type ResolvePolicyIR = ResolvePipelineStepIR[];

export type ResolvePipelineStepIR =
  | { step: "all" }
  | { step: "single" }
  | { step: "from"; expr: string }
  | { step: "filter"; predicate: string }
  | { step: "roundRobin" }
  | { step: "leastLoaded" }
  | { step: "random" }
  | { step: "sample"; count: number }
  | { step: "first" }
  | { step: "fallback"; chain: ResolvePipelineStepIR[] }
  | { step: "custom"; name: string };

// ── From lang/src/ir.ts — Trigger IR ─────────────────────────────────

export type TriggerIR =
  | { kind: "invoke";  withType: string; inputExpr?: string; resolveMap?: Record<string, ResolvePolicyIR> }
  | { kind: "cron";    cron: string; inputExpr?: string; resolveMap?: Record<string, ResolvePolicyIR> }
  | { kind: "event";   topic: string; withType: string; inputExpr?: string; resolveMap?: Record<string, ResolvePolicyIR> };

// ── From lang/src/ir.ts — Agent Registration IR ──────────────────────

export type AgentRegistrationIR = {
  agentName: string;
  roleName: string;
  tags?: string[];
  capabilities?: string[];
  labels?: Record<string, string>;
};

// ── From lang/src/ir.ts — Protocol IR ───────────────────────────────

export type IRGraph = {
  protocolName: string;
  role: string;
  lang: LangTag;
  version?: string;
  fingerprints?: ProtocolFingerprint;
  dependencies?: ProtocolDependency[];
  participants?: ParticipantIR[];
  triggers?: TriggerIR[];
  invocable?: boolean;
  states: IRState[];
  transitions: IRTransition[];
  initialStateId: string;
  terminalStateIds: string[];
};

export type IRStateKind =
  | "initial" | "send" | "receive" | "action" | "guard"
  | "fork" | "join" | "timer" | "terminal" | "error"
  | "invoke" | "async_invoke" | "spawn" | "scatter";

export type IRState = {
  id: string;
  kind: IRStateKind;
  data: IRStateData;
};

export type IRStateData =
  | { kind: "initial" }
  | { kind: "send"; to: string; arrow: ArrowKind; messageName: string; preSendZone?: string; propagateFlow?: boolean }
  | { kind: "receive"; from: string; arrow: ArrowKind; messageName: string; postReceiveZone?: string; pattern?: Record<string, string>; propagateFlow?: boolean }
  | { kind: "action"; body: string; lang: LangTag }
  | { kind: "guard"; guardType: "expression" | "message" | "timeout" | "xor"; expr?: string }
  | { kind: "fork"; branchStartIds: string[] }
  | { kind: "join"; branchCount: number }
  | { kind: "timer"; duration: Duration }
  | { kind: "terminal"; status: "completed" | "error" }
  | { kind: "error"; label: string }
  | { kind: "invoke"; protocolName: string; input: string; roleMapping?: Record<string, string>; resultTarget?: string }
  | { kind: "async_invoke"; protocolName: string; input: string; roleMapping?: Record<string, string> }
  | { kind: "spawn"; roleName: string; config: string; bindAs?: string; resultTarget?: string; persistent: boolean }
  | { kind: "scatter"; collection: string; itemRole: string; branchStartIds: string[] };

export type IRTransition = {
  from: string;
  to: string;
  label: IRTransitionLabel;
};

export type IRTransitionLabel =
  | { kind: "default" }
  | { kind: "message"; messageName: string; pattern?: Record<string, string> }
  | { kind: "timeout"; duration: Duration }
  | { kind: "expression"; expr: string }
  | { kind: "else" }
  | { kind: "error" }
  | { kind: "branch"; branchIndex: number };

// ── From lang/src/ir.ts — Role IR ───────────────────────────────────

export type RoleIR = {
  roleName: string;
  lang?: LangTag;
  version?: string;
  fingerprints?: RoleFingerprint;
  extends?: string;
  plays: AgentPlaysBinding[];
  initAction?: AgentAction;
  lifecycleHandlers: AgentLifecycleHandler[];
};

// ── From lang/src/ir.ts — Agent IR (thin on-disk format) ────────────

export type ThinAgentIR = {
  agentName: string;
  lang: LangTag;
  roleName: string;
  roleFile: string;
  tags?: string[];
  capabilities?: string[];
  labels?: Record<string, string>;
};

// ── Resolved Agent IR (what the runtime works with) ─────────────────

export type AgentIR = {
  agentName: string;
  lang: LangTag;
  roleName: string;
  plays: AgentPlaysBinding[];
  initAction?: AgentAction;
  lifecycleHandlers: AgentLifecycleHandler[];
};

export function resolveAgentIR(thin: ThinAgentIR, role: RoleIR): AgentIR {
  return {
    agentName: thin.agentName,
    lang: thin.lang,
    roleName: thin.roleName,
    plays: role.plays,
    initAction: role.initAction,
    lifecycleHandlers: role.lifecycleHandlers,
  };
}

// ── RC Ontology Types ────────────────────────────────────────────────

export type ProtocolArtifacts = {
  protocolName: string;
  version?: string;
  graphs: Map<string, IRGraph>;
};

export type AgentRuntimeLifecycle =
  | "attached"
  | "ready"
  | "stopped"
  | "detached";

export type AgentRecordLifecycle =
  | "declared"
  | "runtime_attached"
  | "ready"
  | "detached"
  | "destroyed";

export type AgentRuntimeRef = {
  runtimeName: string;
  lifecycle: AgentRuntimeLifecycle;
  nodeId?: string;
  attachedAt?: number;
  readyAt?: number;
};

export type AgentRecord = {
  name: string;
  role: string;
  nodeId?: string;
  templateId?: string;
  lifecycle: AgentRecordLifecycle;
  tags: string[];
  capabilities: string[];
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
  runtime?: AgentRuntimeRef;
};

export type NodeControlEndpointRef = {
  kind: "ws";
  url: string;
};

export type NodeControlCapabilities = {
  deploy?: boolean;
  inspect?: boolean;
  trigger?: boolean;
  debug?: boolean;
  trace?: boolean;
  stateStoreProxy?: boolean;
};

export type NodeRegistration = {
  nodeId: string;
  startedAt: string;
  control?: NodeControlEndpointRef;
  capabilities?: NodeControlCapabilities;
  metadata?: Record<string, unknown>;
};

export type AgentTemplate = {
  templateId: string;
  agentName: string;
  roleIR: RoleIR;
  graphs: Map<string, IRGraph>;
  extras?: Record<string, unknown>;
};

export function isAddressableAgentRecord(record: Pick<AgentRecord, "nodeId" | "lifecycle" | "runtime">): boolean {
  if (!record.nodeId) return false;
  if (record.runtime?.lifecycle === "attached" || record.runtime?.lifecycle === "ready") {
    return true;
  }
  return record.lifecycle === "runtime_attached" || record.lifecycle === "ready";
}

export type AgentPlaysBinding = {
  protocolName: string;
  roleName: string;
};

export type AgentAction = {
  body: string;
  lang: LangTag;
};

export type AgentLifecycleHandler = {
  event: AgentEventKind;
  protocolFilter?: string;
  action: AgentAction;
};

// ── Message Envelope ────────────────────────────────────────────────

export type MessageEnvelope = {
  instanceId: string;
  protocolName: string;
  protocolVersion?: string;
  from: { agent: string; role: string };
  to: { agent: string; role: string };
  messageName: string;
  payload: Record<string, unknown>;
  ts: number;
  idempotencyKey: string;
};

// ── Trace Events ────────────────────────────────────────────────────

export type TraceEventKind =
  | "ProtocolStarted"
  | "ProtocolCompleted"
  | "ProtocolFailed"
  | "MessageSent"
  | "MessageReceived"
  | "ActionStarted"
  | "ActionFinished"
  | "GuardEvaluated"
  | "TimerStarted"
  | "TimerFired"
  | "ForkStarted"
  | "JoinCompleted"
  | "ErrorCaught"
  | "InvokeStarted"
  | "InvokeCompleted"
  | "AsyncInvokeStarted"
  | "Spawned"
  | "ScatterStarted"
  | "ScatterCompleted"
  | "EventEmitted"
  | "TriggerMatched"
  | "TriggerSuppressed"
  | "TriggerDedupSkipped"
  | "CronTick"
  | "ResolveCompleted"
  | "SpawnStarted"
  | "SpawnCompleted"
  | "SpawnFailed";

export type TraceEvent = {
  instanceId: string;
  eventId: string;
  kind: TraceEventKind;
  ts: number;
  agent: string;
  role?: string;
  protocolName?: string;
  data?: Record<string, unknown>;
  cause?: string;
};

// ── Protocol Trigger ────────────────────────────────────────────────

export type ProtocolTrigger = {
  instanceId: string;
  protocolName: string;
  protocolVersion?: string;
  input: Record<string, unknown>;
  roleToAgent: RoleBindingMap | LegacyRoleBindingMap;
};

// ── Deployment Plan ─────────────────────────────────────────────────

export type DeploymentAgent = {
  agentName: string;
  lang: string;
  roleName: string;
  agentIRFile: string;
  roleIRFile: string;
  roles: Array<{
    protocolName: string;
    roleName: string;
    irGraphFile: string;
  }>;
};

export type DeploymentPlan = {
  agents: DeploymentAgent[];
  roleToAgent: RoleBindingMap | LegacyRoleBindingMap;
};

// ── Subject helpers ─────────────────────────────────────────────────

export function msgSubject(instanceId: string, toAgent: string, messageName: string): string {
  return `reagent.msg.${instanceId}.${toAgent}.${messageName}`;
}

export function msgSubscribePattern(agentName: string): string {
  return `reagent.msg.*.${agentName}.>`;
}

export function traceSubject(instanceId: string): string {
  return `reagent.trace.${instanceId}`;
}

export function traceSubscribeAll(): string {
  return "reagent.trace.>";
}

export function triggerSubject(agentName: string): string {
  return `reagent.trigger.${agentName}`;
}

// ── Factories ───────────────────────────────────────────────────────

export function createMessageEnvelope(
  instanceId: string,
  protocolName: string,
  fromAgent: string,
  fromRole: string,
  toAgent: string,
  toRole: string,
  messageName: string,
  payload: Record<string, unknown>,
  protocolVersion?: string,
): MessageEnvelope {
  return {
    instanceId,
    protocolName,
    protocolVersion,
    from: { agent: fromAgent, role: fromRole },
    to: { agent: toAgent, role: toRole },
    messageName,
    payload,
    ts: Date.now(),
    idempotencyKey: crypto.randomUUID(),
  };
}

export function createTraceEvent(
  instanceId: string,
  kind: TraceEventKind,
  agent: string,
  opts?: {
    role?: string;
    protocolName?: string;
    data?: Record<string, unknown>;
    cause?: string;
  },
): TraceEvent {
  return {
    instanceId,
    eventId: crypto.randomUUID(),
    kind,
    ts: Date.now(),
    agent,
    role: opts?.role,
    protocolName: opts?.protocolName,
    data: opts?.data,
    cause: opts?.cause,
  };
}
