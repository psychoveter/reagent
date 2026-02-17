/**
 * Reagent IR — v0.0.5
 *
 * Two levels of IR:
 *
 * 1. Protocol IR (IRGraph) — per-role state machine representation.
 *    Each role in a protocol gets its own IRGraph — the local view of the global choreography.
 *    The IR is a directed graph: states (nodes) connected by transitions (edges).
 *
 * 2. Agent IR (AgentIR) — per-agent metadata that ties protocols together.
 *    Each agent gets an AgentIR describing which protocols it plays,
 *    its init action, and lifecycle event handlers.
 */

import type { AgentEventKind, ArrowKind, Duration, LangTag } from "./ast.js";

// ── IR Graph (per-role) ─────────────────────────────────────────────

export type IRGraph = {
  protocolName: string;
  role: string;
  lang: LangTag;
  states: IRState[];
  transitions: IRTransition[];
  initialStateId: string;
  terminalStateIds: string[];
};

// ── IR States ───────────────────────────────────────────────────────

export type IRStateKind =
  | "initial"
  | "send"
  | "receive"
  | "action"
  | "guard"
  | "fork"
  | "join"
  | "timer"
  | "terminal"
  | "error";

export type IRState = {
  id: string;
  kind: IRStateKind;
  data: IRStateData;
};

export type IRStateData =
  | IRInitialData
  | IRSendData
  | IRReceiveData
  | IRActionData
  | IRGuardData
  | IRForkData
  | IRJoinData
  | IRTimerData
  | IRTerminalData
  | IRErrorData;

export type IRInitialData = {
  kind: "initial";
};

export type IRSendData = {
  kind: "send";
  to: string;
  arrow: ArrowKind;
  messageName: string;
  /** Zone body to execute before sending (onSend hook or inline) */
  preSendZone?: string;
};

export type IRReceiveData = {
  kind: "receive";
  from: string;
  arrow: ArrowKind;
  messageName: string;
  /** Zone body to execute after receiving (onReceive hook) */
  postReceiveZone?: string;
  /** Pattern/guard for message matching in alt branches */
  pattern?: Record<string, string>;
};

export type IRActionData = {
  kind: "action";
  /** Raw host-language code body */
  body: string;
  lang: LangTag;
};

export type IRGuardData = {
  kind: "guard";
  guardType: "expression" | "message" | "timeout" | "xor";
  /** For expression guards: the $ctx expression to evaluate */
  expr?: string;
};

export type IRForkData = {
  kind: "fork";
  /** IDs of the first state in each parallel branch */
  branchStartIds: string[];
};

export type IRJoinData = {
  kind: "join";
  /** Number of branches that must complete before this join fires */
  branchCount: number;
};

export type IRTimerData = {
  kind: "timer";
  duration: Duration;
};

export type IRTerminalData = {
  kind: "terminal";
  status: "completed" | "error";
};

export type IRErrorData = {
  kind: "error";
  /** Catch label */
  label: string;
};

// ── IR Transitions ──────────────────────────────────────────────────

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

// ── Agent IR (per-agent) ────────────────────────────────────────────

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
