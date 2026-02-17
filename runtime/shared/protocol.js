"use strict";
/**
 * Reagent Runtime Protocol — shared message envelope, subject convention, and trace event types.
 *
 * This module defines the wire protocol used between agent runners over NATS.
 * Both the TypeScript and Python runtimes must conform to these schemas.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.msgSubject = msgSubject;
exports.msgSubscribePattern = msgSubscribePattern;
exports.traceSubject = traceSubject;
exports.traceSubscribeAll = traceSubscribeAll;
exports.lifecycleSubject = lifecycleSubject;
exports.triggerSubject = triggerSubject;
exports.createMessageEnvelope = createMessageEnvelope;
exports.createTraceEvent = createTraceEvent;
const node_crypto_1 = require("node:crypto");
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
function msgSubject(instanceId, toAgent, messageName) {
    return `reagent.msg.${instanceId}.${toAgent}.${messageName}`;
}
function msgSubscribePattern(agentName) {
    return `reagent.msg.*.${agentName}.>`;
}
function traceSubject(instanceId) {
    return `reagent.trace.${instanceId}`;
}
function traceSubscribeAll() {
    return "reagent.trace.>";
}
function lifecycleSubject(agentName) {
    return `reagent.lifecycle.${agentName}`;
}
function triggerSubject(agentName) {
    return `reagent.trigger.${agentName}`;
}
function createMessageEnvelope(instanceId, protocolName, fromAgent, fromRole, toAgent, toRole, messageName, payload) {
    return {
        instanceId,
        protocolName,
        from: { agent: fromAgent, role: fromRole },
        to: { agent: toAgent, role: toRole },
        messageName,
        payload,
        ts: Date.now(),
        idempotencyKey: (0, node_crypto_1.randomUUID)(),
    };
}
function createTraceEvent(instanceId, kind, agent, opts) {
    return {
        instanceId,
        eventId: (0, node_crypto_1.randomUUID)(),
        kind,
        ts: Date.now(),
        agent,
        role: opts?.role,
        protocolName: opts?.protocolName,
        data: opts?.data,
        cause: opts?.cause,
    };
}
