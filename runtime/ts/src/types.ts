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

// ── From lang/src/ir.ts — Protocol IR ───────────────────────────────

export type IRGraph = {
  protocolName: string;
  role: string;
  lang: LangTag;
  states: IRState[];
  transitions: IRTransition[];
  initialStateId: string;
  terminalStateIds: string[];
};

export type IRStateKind =
  | "initial" | "send" | "receive" | "action" | "guard"
  | "fork" | "join" | "timer" | "terminal" | "error";

export type IRState = {
  id: string;
  kind: IRStateKind;
  data: IRStateData;
};

export type IRStateData =
  | { kind: "initial" }
  | { kind: "send"; to: string; arrow: ArrowKind; messageName: string; preSendZone?: string }
  | { kind: "receive"; from: string; arrow: ArrowKind; messageName: string; postReceiveZone?: string; pattern?: Record<string, string> }
  | { kind: "action"; body: string; lang: LangTag }
  | { kind: "guard"; guardType: "expression" | "message" | "timeout" | "xor"; expr?: string }
  | { kind: "fork"; branchStartIds: string[] }
  | { kind: "join"; branchCount: number }
  | { kind: "timer"; duration: Duration }
  | { kind: "terminal"; status: "completed" | "error" }
  | { kind: "error"; label: string };

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

// ── From lang/src/ir.ts — Agent IR ──────────────────────────────────

export type AgentIR = {
  agentName: string;
  lang: LangTag;
  plays: AgentPlaysBinding[];
  initAction?: AgentAction;
  lifecycleHandlers: AgentLifecycleHandler[];
};

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
  | "GuardEvaluated";

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
  input: Record<string, unknown>;
  roleToAgent: Record<string, string>;
};

// ── Deployment Plan ─────────────────────────────────────────────────

export type DeploymentAgent = {
  agentName: string;
  lang: string;
  agentIRFile: string;
  roles: Array<{
    protocolName: string;
    roleName: string;
    irGraphFile: string;
  }>;
};

export type DeploymentPlan = {
  agents: DeploymentAgent[];
  roleToAgent: Record<string, string>;
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
): MessageEnvelope {
  return {
    instanceId,
    protocolName,
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
