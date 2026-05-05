/**
 * Reagent Runtime Protocol — shared message envelope, subject convention, and trace event types.
 *
 * This module defines the wire protocol used between agent runners over NATS.
 * Both the TypeScript and Python runtimes must conform to these schemas.
 */
export declare function msgSubject(instanceId: string, toAgent: string, messageName: string): string;
export declare function msgSubscribePattern(agentName: string): string;
export declare function traceSubject(instanceId: string): string;
export declare function traceSubscribeAll(): string;
export declare function lifecycleSubject(agentName: string): string;
export declare function triggerSubject(agentName: string): string;
export type MessageEnvelope = {
    instanceId: string;
    protocolName: string;
    from: {
        agent: string;
        role: string;
    };
    to: {
        agent: string;
        role: string;
    };
    messageName: string;
    payload: Record<string, unknown>;
    ts: number;
    idempotencyKey: string;
};
export declare function createMessageEnvelope(instanceId: string, protocolName: string, fromAgent: string, fromRole: string, toAgent: string, toRole: string, messageName: string, payload: Record<string, unknown>): MessageEnvelope;
export type TraceEventKind = "ProtocolStarted" | "ProtocolCompleted" | "ProtocolFailed" | "MessageSent" | "MessageReceived" | "ActionStarted" | "ActionFinished" | "GuardEvaluated" | "AltEvaluated" | "AltBranchChosen";
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
export declare function createTraceEvent(instanceId: string, kind: TraceEventKind, agent: string, opts?: {
    role?: string;
    protocolName?: string;
    data?: Record<string, unknown>;
    cause?: string;
}): TraceEvent;
export type ProtocolTrigger = {
    instanceId: string;
    protocolName: string;
    input: Record<string, unknown>;
    roleToAgent: Record<string, string>;
};
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
