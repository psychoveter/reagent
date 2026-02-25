/**
 * Reagent IR — v0.0.11
 *
 * Three levels of IR:
 *
 * 1. Protocol IR (IRGraph) — per-role state machine representation.
 *    Each role in a protocol gets its own IRGraph — the local view of the global choreography.
 *    The IR is a directed graph: states (nodes) connected by transitions (edges).
 *
 * 2. Role IR (RoleIR) — per-role behavioral contract with lifecycle.
 *    Rich representation of the role: plays, init, handlers, inheritance chain.
 *
 * 3. Agent IR (AgentIR) — thin per-agent deployment binding.
 *    References the role it runs; the runtime resolves behavioral details from RoleIR.
 */
import type { RoleEventKind, ArrowKind, Duration, LangTag, TypeExpr } from "./ast.js";
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
export type IRGraph = {
    protocolName: string;
    role: string;
    lang: LangTag;
    version?: string;
    fingerprints?: ProtocolFingerprint;
    dependencies?: ProtocolDependency[];
    initiator?: string;
    states: IRState[];
    transitions: IRTransition[];
    initialStateId: string;
    terminalStateIds: string[];
};
export type IRStateKind = "initial" | "send" | "receive" | "action" | "guard" | "fork" | "join" | "timer" | "terminal" | "error" | "invoke" | "spawn" | "scatter";
export type IRState = {
    id: string;
    kind: IRStateKind;
    data: IRStateData;
};
export type IRStateData = IRInitialData | IRSendData | IRReceiveData | IRActionData | IRGuardData | IRForkData | IRJoinData | IRTimerData | IRTerminalData | IRErrorData | IRInvokeData | IRSpawnData | IRScatterData;
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
    /** If true, preSendZone contains `await` and requires async execution */
    preSendAsync?: boolean;
};
export type IRReceiveData = {
    kind: "receive";
    from: string;
    arrow: ArrowKind;
    messageName: string;
    /** Zone body to execute after receiving (onReceive hook) */
    postReceiveZone?: string;
    /** If true, postReceiveZone contains `await` and requires async execution */
    postReceiveAsync?: boolean;
    /** Pattern/guard for message matching in alt branches */
    pattern?: Record<string, string>;
};
export type IRActionData = {
    kind: "action";
    /** Raw host-language code body */
    body: string;
    lang: LangTag;
    /** If true, zone body contains `await` and requires async execution */
    async?: boolean;
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
export type IRInvokeData = {
    kind: "invoke";
    protocolName: string;
    input: string;
    roleMapping?: Record<string, string>;
    resultTarget?: string;
};
export type IRSpawnData = {
    kind: "spawn";
    protocolName: string;
    input: string;
    roleMapping?: Record<string, string>;
};
export type IRScatterData = {
    kind: "scatter";
    collection: string;
    itemRole: string;
    branchStartIds: string[];
};
export type IRTransition = {
    from: string;
    to: string;
    label: IRTransitionLabel;
};
export type IRTransitionLabel = {
    kind: "default";
} | {
    kind: "message";
    messageName: string;
    pattern?: Record<string, string>;
} | {
    kind: "timeout";
    duration: Duration;
} | {
    kind: "expression";
    expr: string;
} | {
    kind: "else";
} | {
    kind: "error";
} | {
    kind: "branch";
    branchIndex: number;
};
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
export type AgentIR = {
    agentName: string;
    lang: LangTag;
    roleName: string;
    roleFile: string;
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
    event: RoleEventKind;
    protocolFilter?: string;
    action: AgentAction;
};
export type IRMessageSchema = {
    name: string;
    fields: IRFieldSchema[];
};
export type IRFieldSchema = {
    name: string;
    type: TypeExpr;
    optional: boolean;
};
