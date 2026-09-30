/**
 * Reagent Runtime Protocol — shared message envelope, subject convention, and trace event types.
 *
 * This module defines the wire protocol used between agent runners over NATS.
 * Any present and future Reagent runtimes must conform to these schemas.
 */

import { randomUUID } from "node:crypto";

// ── NATS Subject Convention ─────────────────────────────────────────
//
// Messages between agents:
//   reagent.msg.<instanceId>.<toAgent>.<messageName>
//
// Trace events (all agents publish here, orchestrator subscribes):
//   reagent.trace.<instanceId>
//
// Agent lifecycle (init done, protocol instance events):
//   reagent.lifecycle.<agentName>
//
// Protocol trigger (orchestrator -> initiator agent):
//   reagent.trigger.<agentName>

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

export function lifecycleSubject(agentName: string): string {
  return `reagent.lifecycle.${agentName}`;
}

export function triggerSubject(agentName: string): string {
  return `reagent.trigger.${agentName}`;
}

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
    idempotencyKey: randomUUID(),
  };
}

// ── Trace Events ────────────────────────────────────────────────────
//
// Based on reagent-spec.md TraceEvent algebra.

export type TraceEventKind =
  | "ProtocolStarted"
  | "ProtocolCompleted"
  | "ProtocolFailed"
  | "MessageSent"
  | "MessageReceived"
  | "ActionStarted"
  | "ActionFinished"
  | "GuardEvaluated"
  | "AltEvaluated"
  | "AltBranchChosen";

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
    eventId: randomUUID(),
    kind,
    ts: Date.now(),
    agent,
    role: opts?.role,
    protocolName: opts?.protocolName,
    data: opts?.data,
    cause: opts?.cause,
  };
}

// ── Protocol Trigger ────────────────────────────────────────────────

export type ProtocolTrigger = {
  instanceId: string;
  protocolName: string;
  input: Record<string, unknown>;
  roleToAgent: Record<string, string>; // "ProtoName.roleName" -> agentName
};

// ── Deployment Plan (loaded by orchestrator) ────────────────────────

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
