/**
 * M5-CTRL Functional E2E Tests
 *
 * These tests validate the new connectivity layer:
 * - ReagentController + NativeAgentNode + loopback routing (no NATS required)
 * - InMemoryNodeLink for multi-node scenarios
 * - Interceptor chain
 * - TraceHook
 * - AddressPage routing
 *
 * C1:  Single-node loopback
 * C2:  Multi-node via InMemoryNodeLink
 * C3:  Message-level interceptor (spy)
 * C4:  Interceptor drops message
 * C5:  TraceHook fires
 * C6:  AgentRef.send convenience
 * C7:  Routing table from AddressPage
 * C8:  Dynamic agent spawn (via RC)
 * C9:  External trigger via RC API
 * C10: Multi-protocol on single node
 * C11: Agent in multiple protocols
 * C12: Cross-language TS<->Python via RC
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ReagentController, type ReagentControllerConfig } from "../ts/src/controller/reagent-controller.js";
import { NativeAgentNode, NativeAgentHandle, type NativeAgentNodeConfig } from "../ts/src/nodes/native-agent-node.js";
import { PythonAgentNode, PythonAgentHandle } from "../ts/src/nodes/python-agent-node.js";
import { createInMemoryLinkPair } from "../ts/src/network/inmemory-node-link.js";
import type { AgentIR, IRGraph, ThinAgentIR, RoleIR, TraceEvent, MessageEnvelope } from "../ts/src/contracts/types.js";
import { resolveAgentIR } from "../ts/src/contracts/types.js";
import type { InterceptorFn, InterceptorContext, TraceHook } from "../ts/src/contracts/interceptor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "14-ts-only-demo");
const LOOP_FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "15-loop-and-wait-demo");
const PAR_FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "16-parallel-demo");
const INVOKE_FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "18-invoke-demo");
const SPAWN_FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "19-spawn-emit-demo");
const MULTI_PROTO_DIR = join(__dirname, "..", "..", "examples", "out", "22-multi-protocol-agent");
const CROSS_LANG_DIR = join(__dirname, "..", "..", "examples", "out", "20-cross-lang-e2e");
const PY_RUNTIME_DIR = join(__dirname, "..", "py");

type TestResult = { name: string; passed: boolean; error?: string };

// ── Helpers ─────────────────────────────────────────────────────────

function loadRoleIR(dir: string, agentName: string): { roleIR: RoleIR; agentIR: AgentIR } {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${agentName}.agent.json`), "utf8"));
  const roleIR: RoleIR = JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
  const agentIR = resolveAgentIR(thin, roleIR);
  return { roleIR, agentIR };
}

function loadGraph(dir: string, proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(dir, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeploymentFrom(dir: string): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, "deployment.json"), "utf8"));
}

function createSingleNodeSetup(
  dir: string,
  agents: Array<{ name: string; graphEntries: Array<{ proto: string; role: string }> }>,
  opts?: { interceptors?: InterceptorFn[]; traceHook?: TraceHook },
): {
  rc: ReagentController;
  deployment: { roleToAgent: Record<string, string> };
} {
  const deployment = loadDeploymentFrom(dir);

  const agentNode = new NativeAgentNode({
    roleToAgent: deployment.roleToAgent,
    traceHook: opts?.traceHook,
  });

  const rc = new ReagentController({
    nodeId: "test-node",
    agentNode,
    interceptors: opts?.interceptors,
  });

  for (const agentDef of agents) {
    const { roleIR } = loadRoleIR(dir, agentDef.name);
    const graphs = new Map<string, IRGraph>();
    for (const ge of agentDef.graphEntries) {
      const graph = loadGraph(dir, ge.proto, ge.role);
      graphs.set(`${ge.proto}.${ge.role}`, graph);
    }
    rc.registerAgent(agentDef.name, roleIR, graphs);
  }

  return { rc, deployment };
}

function getHandle(rc: ReagentController, name: string): NativeAgentHandle {
  return rc.getAgent(name) as NativeAgentHandle;
}

// ── C1: Single-node loopback ────────────────────────────────────────

async function testC1(): Promise<TestResult> {
  const name = "C1: Single-node loopback";

  try {
    const { rc, deployment } = createSingleNodeSetup(FIXTURES_DIR, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ]);

    await rc.start();

    const instanceId = randomUUID();
    const trigger = {
      instanceId,
      protocolName: "TsDemo",
      input: { text: "hello" },
      roleToAgent: deployment.roleToAgent,
    };

    rc.triggerProtocol("ClientAgent", trigger);
    rc.triggerProtocol("HandlerAgent", trigger);

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    const hi = handler.getInstances().get(instanceId)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client: ${ci.getStatus()}` };
    if (hi.getStatus() !== "completed") return { name, passed: false, error: `Handler: ${hi.getStatus()}` };

    const cTraces = ci.getTraces();
    const hTraces = hi.getTraces();
    if (!cTraces.some(t => t.kind === "MessageSent")) return { name, passed: false, error: "No MessageSent in client" };
    if (!hTraces.some(t => t.kind === "MessageReceived")) return { name, passed: false, error: "No MessageReceived in handler" };
    if (!hTraces.some(t => t.kind === "MessageSent")) return { name, passed: false, error: "No MessageSent in handler" };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C2: Multi-node via InMemoryNodeLink ─────────────────────────────

async function testC2(): Promise<TestResult> {
  const name = "C2: Multi-node via InMemoryNodeLink";

  try {
    const deployment = loadDeploymentFrom(FIXTURES_DIR);

    const node1AgentNode = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
    const node2AgentNode = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });

    const rc1 = new ReagentController({ nodeId: "node-1", agentNode: node1AgentNode });
    const rc2 = new ReagentController({ nodeId: "node-2", agentNode: node2AgentNode });

    const [link1, link2] = createInMemoryLinkPair("node-1", "node-2");
    rc1.addNodeLink(link1);
    rc2.addNodeLink(link2);

    // Client on node-1, Handler on node-2
    const { roleIR: clientRole } = loadRoleIR(FIXTURES_DIR, "ClientAgent");
    const clientGraphs = new Map([["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")]]);
    rc1.registerAgent("ClientAgent", clientRole, clientGraphs);

    const { roleIR: handlerRole } = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
    const handlerGraphs = new Map([["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")]]);
    rc2.registerAgent("HandlerAgent", handlerRole, handlerGraphs);

    // Tell node-1 that HandlerAgent is on node-2
    rc1.registerRemoteAgent("HandlerAgent", "node-2");
    // Tell node-2 that ClientAgent is on node-1
    rc2.registerRemoteAgent("ClientAgent", "node-1");

    await rc1.start();
    await rc2.start();

    const instanceId = randomUUID();
    const trigger = {
      instanceId,
      protocolName: "TsDemo",
      input: { text: "hello" },
      roleToAgent: deployment.roleToAgent,
    };

    rc1.triggerProtocol("ClientAgent", trigger);
    rc2.triggerProtocol("HandlerAgent", trigger);

    const client = getHandle(rc1, "ClientAgent");
    const handler = getHandle(rc2, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    const hi = handler.getInstances().get(instanceId)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client: ${ci.getStatus()}` };
    if (hi.getStatus() !== "completed") return { name, passed: false, error: `Handler: ${hi.getStatus()}` };

    await rc1.stop();
    await rc2.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C3: Message-level interceptor (spy) ─────────────────────────────

async function testC3(): Promise<TestResult> {
  const name = "C3: Message-level interceptor";

  try {
    const captured: InterceptorContext[] = [];
    const spy: InterceptorFn = (ctx, next) => {
      captured.push({ ...ctx });
      next();
    };

    const { rc, deployment } = createSingleNodeSetup(FIXTURES_DIR, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ], { interceptors: [spy] });

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    if (captured.length === 0) return { name, passed: false, error: "Interceptor captured nothing" };

    const hasLoopback = captured.some(c => c.direction === "loopback");
    if (!hasLoopback) return { name, passed: false, error: "No loopback messages captured" };

    const msgNames = captured.map(c => c.envelope.messageName);
    if (!msgNames.includes("Query")) return { name, passed: false, error: `Expected Query, got: ${JSON.stringify(msgNames)}` };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C4: Interceptor drops message ───────────────────────────────────

async function testC4(): Promise<TestResult> {
  const name = "C4: Interceptor drops message";

  try {
    const dropper: InterceptorFn = (ctx, next) => {
      // Drop "Accept" messages — don't call next()
      if (ctx.envelope.messageName === "Accept") return;
      next();
    };

    const { rc, deployment } = createSingleNodeSetup(FIXTURES_DIR, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ], { interceptors: [dropper] });

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });

    // Wait a bit — client should NOT complete because Accept is dropped
    await new Promise(r => setTimeout(r, 2000));

    const client = getHandle(rc, "ClientAgent");
    const ci = client.getInstances().get(instanceId);

    if (!ci) return { name, passed: false, error: "Client instance not created" };
    if (ci.getStatus() === "completed") return { name, passed: false, error: "Client completed despite dropped Accept" };

    // Handler should have completed (it sent Accept, doesn't wait for delivery)
    const handler = getHandle(rc, "HandlerAgent");
    const hi = handler.getInstances().get(instanceId);
    if (!hi || hi.getStatus() !== "completed") return { name, passed: false, error: `Handler: ${hi?.getStatus()}` };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C5: TraceHook fires ─────────────────────────────────────────────

async function testC5(): Promise<TestResult> {
  const name = "C5: TraceHook fires";

  try {
    const traceEvents: TraceEvent[] = [];
    const hook: TraceHook = (event) => {
      traceEvents.push(event);
    };

    const { rc, deployment } = createSingleNodeSetup(FIXTURES_DIR, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ], { traceHook: hook });

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    if (traceEvents.length === 0) return { name, passed: false, error: "No trace events captured" };

    const kinds = traceEvents.map(t => t.kind);
    if (!kinds.includes("ProtocolStarted")) return { name, passed: false, error: "Missing ProtocolStarted" };
    if (!kinds.includes("MessageSent")) return { name, passed: false, error: "Missing MessageSent" };
    if (!kinds.includes("MessageReceived")) return { name, passed: false, error: "Missing MessageReceived" };
    if (!kinds.includes("ProtocolCompleted")) return { name, passed: false, error: "Missing ProtocolCompleted" };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C6: AgentRef.send convenience ───────────────────────────────────

async function testC6(): Promise<TestResult> {
  const name = "C6: AgentRef.send convenience";

  try {
    const { rc } = createSingleNodeSetup(FIXTURES_DIR, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ]);

    // Verify AgentRef creation and that it has the right structure
    const transport = rc.createTransport("TestProbe");
    const ref = transport.ref("HandlerAgent");

    if (ref.agentName !== "HandlerAgent") return { name, passed: false, error: `agentName: ${ref.agentName}` };
    if (!ref.nodeRef) return { name, passed: false, error: "nodeRef is missing" };
    if (ref.nodeRef.nodeId !== "test-node") return { name, passed: false, error: `nodeRef.nodeId: ${ref.nodeRef.nodeId}` };

    // Verify sendEnvelope works without errors (captures that routing table is set up)
    let received: MessageEnvelope | null = null;
    const deployment = loadDeploymentFrom(FIXTURES_DIR);

    const node = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
    const rc2 = new ReagentController({ nodeId: "c6-node", agentNode: node });

    // Register a minimal "receiver" transport to capture the envelope
    const recvTransport = rc2.createTransport("Receiver");
    recvTransport.onMessage((env) => { received = env; });

    const senderTransport = rc2.createTransport("Sender");
    const sRef = senderTransport.ref("Receiver");

    // Use sendEnvelope with a manually built envelope
    const { createMessageEnvelope } = await import("../ts/src/contracts/types.js");
    const env = createMessageEnvelope("inst-1", "TestProto", "Sender", "roleA", "Receiver", "roleB", "TestMsg", { val: 42 });
    sRef.sendEnvelope(env);

    if (!received) return { name, passed: false, error: "Receiver didn't get the envelope" };
    if (received.messageName !== "TestMsg") return { name, passed: false, error: `messageName: ${received.messageName}` };
    if ((received.payload as any).val !== 42) return { name, passed: false, error: `payload.val: ${(received.payload as any).val}` };
    if (received.from.agent !== "Sender") return { name, passed: false, error: `from.agent: ${received.from.agent}` };
    if (received.to.agent !== "Receiver") return { name, passed: false, error: `to.agent: ${received.to.agent}` };
    if (!received.ts) return { name, passed: false, error: "ts is missing" };
    if (!received.idempotencyKey) return { name, passed: false, error: "idempotencyKey is missing" };

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C7: Routing table from AddressPage ──────────────────────────────

async function testC7(): Promise<TestResult> {
  const name = "C7: Routing table from AddressPage";

  try {
    const deployment = loadDeploymentFrom(FIXTURES_DIR);

    const node1AN = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
    const node2AN = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });

    const rc1 = new ReagentController({ nodeId: "node-1", agentNode: node1AN });
    const rc2 = new ReagentController({ nodeId: "node-2", agentNode: node2AN });

    const [link1, link2] = createInMemoryLinkPair("node-1", "node-2");
    rc1.addNodeLink(link1);
    rc2.addNodeLink(link2);

    // Client on node-1
    const { roleIR: clientRole } = loadRoleIR(FIXTURES_DIR, "ClientAgent");
    rc1.registerAgent("ClientAgent", clientRole, new Map([["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")]]));

    // Handler on node-2
    const { roleIR: handlerRole } = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
    rc2.registerAgent("HandlerAgent", handlerRole, new Map([["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")]]));

    // Instead of registerRemoteAgent, use AddressPage
    rc1.applyAddressPage({
      sourceNodeId: "node-2",
      agents: [{ agentName: "HandlerAgent", nodeId: "node-2" }],
      nodes: [{ nodeId: "node-2", linkType: "inmemory" }],
      ts: Date.now(),
    });
    rc2.applyAddressPage({
      sourceNodeId: "node-1",
      agents: [{ agentName: "ClientAgent", nodeId: "node-1" }],
      nodes: [{ nodeId: "node-1", linkType: "inmemory" }],
      ts: Date.now(),
    });

    await rc1.start();
    await rc2.start();

    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent };
    rc1.triggerProtocol("ClientAgent", trigger);
    rc2.triggerProtocol("HandlerAgent", trigger);

    const client = getHandle(rc1, "ClientAgent");
    const handler = getHandle(rc2, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    const hi = handler.getInstances().get(instanceId)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client: ${ci.getStatus()}` };
    if (hi.getStatus() !== "completed") return { name, passed: false, error: `Handler: ${hi.getStatus()}` };

    await rc1.stop();
    await rc2.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C8: Dynamic agent spawn ─────────────────────────────────────────

async function testC8(): Promise<TestResult> {
  const name = "C8: Dynamic agent spawn";

  try {
    const deployment = loadDeploymentFrom(FIXTURES_DIR);
    const node = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
    const rc = new ReagentController({ nodeId: "spawn-node", agentNode: node });

    // Register only ClientAgent initially
    const { roleIR: clientRole } = loadRoleIR(FIXTURES_DIR, "ClientAgent");
    rc.registerAgent("ClientAgent", clientRole, new Map([["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")]]));

    // Dynamically spawn HandlerAgent
    const { roleIR: handlerRole } = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
    rc.spawnAgent("HandlerAgent", handlerRole, new Map([["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")]]));

    if (!rc.hasAgent("HandlerAgent")) return { name, passed: false, error: "HandlerAgent not registered after spawn" };

    await rc.start();

    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent };
    rc.triggerProtocol("ClientAgent", trigger);
    rc.triggerProtocol("HandlerAgent", trigger);

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client: ${ci.getStatus()}` };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C9: External trigger via RC API ─────────────────────────────────

async function testC9(): Promise<TestResult> {
  const name = "C9: External trigger via RC API";

  try {
    const { rc, deployment } = createSingleNodeSetup(FIXTURES_DIR, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ]);

    await rc.start();

    const instanceId = randomUUID();

    // Trigger via RC API (not via NATS publish)
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: deployment.roleToAgent });

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    const hi = handler.getInstances().get(instanceId)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client: ${ci.getStatus()}` };
    if (hi.getStatus() !== "completed") return { name, passed: false, error: `Handler: ${hi.getStatus()}` };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C10: Multi-protocol on single node ──────────────────────────────

async function testC10(): Promise<TestResult> {
  const name = "C10: Multi-protocol on single node";

  try {
    // Use two different protocol fixtures: TsDemo and LoopWaitDemo
    const deployment1 = loadDeploymentFrom(FIXTURES_DIR);
    const deployment2 = loadDeploymentFrom(LOOP_FIXTURES_DIR);

    // Merge roleToAgent maps
    const mergedRTA = { ...deployment1.roleToAgent, ...deployment2.roleToAgent };

    const node = new NativeAgentNode({ roleToAgent: mergedRTA });
    const rc = new ReagentController({ nodeId: "multi-proto-node", agentNode: node });

    // Register TsDemo agents
    const { roleIR: clientRole } = loadRoleIR(FIXTURES_DIR, "ClientAgent");
    rc.registerAgent("ClientAgent", clientRole, new Map([["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")]]));

    const { roleIR: handlerRole } = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
    rc.registerAgent("HandlerAgent", handlerRole, new Map([["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")]]));

    // Register LoopWaitDemo agents
    const { roleIR: pollerRole } = loadRoleIR(LOOP_FIXTURES_DIR, "PollerAgent");
    rc.registerAgent("PollerAgent", pollerRole, new Map([["LoopWaitDemo.poller", loadGraph(LOOP_FIXTURES_DIR, "LoopWaitDemo", "poller")]]));

    const { roleIR: responderRole } = loadRoleIR(LOOP_FIXTURES_DIR, "ResponderAgent");
    rc.registerAgent("ResponderAgent", responderRole, new Map([["LoopWaitDemo.responder", loadGraph(LOOP_FIXTURES_DIR, "LoopWaitDemo", "responder")]]));

    await rc.start();

    // Trigger both protocols concurrently
    const id1 = randomUUID();
    const id2 = randomUUID();

    rc.triggerProtocol("ClientAgent", { instanceId: id1, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: mergedRTA });
    rc.triggerProtocol("HandlerAgent", { instanceId: id1, protocolName: "TsDemo", input: { text: "hello" }, roleToAgent: mergedRTA });

    rc.triggerProtocol("PollerAgent", { instanceId: id2, protocolName: "LoopWaitDemo", input: {}, roleToAgent: mergedRTA });
    rc.triggerProtocol("ResponderAgent", { instanceId: id2, protocolName: "LoopWaitDemo", input: {}, roleToAgent: mergedRTA });

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");
    const poller = getHandle(rc, "PollerAgent");
    const responder = getHandle(rc, "ResponderAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
      poller.waitForCompletion(1, 15000),
      responder.waitForCompletion(1, 15000),
    ]);

    // Verify no cross-talk: each instance ID has its own traces
    const ci = client.getInstances().get(id1)!;
    const hi = handler.getInstances().get(id1)!;
    const pi = poller.getInstances().get(id2)!;
    const ri = responder.getInstances().get(id2)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client: ${ci.getStatus()}` };
    if (hi.getStatus() !== "completed") return { name, passed: false, error: `Handler: ${hi.getStatus()}` };
    if (pi.getStatus() !== "completed") return { name, passed: false, error: `Poller: ${pi.getStatus()}` };
    if (ri.getStatus() !== "completed") return { name, passed: false, error: `Responder: ${ri.getStatus()}` };

    // Verify TsDemo messages don't appear in LoopWaitDemo traces and vice versa
    const pollerTraceMessages = pi.getTraces().filter(t => t.kind === "MessageSent").map(t => t.data?.messageName);
    if (pollerTraceMessages.includes("Query")) return { name, passed: false, error: "Cross-talk: Poller has TsDemo message" };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C11: Agent in multiple protocols ─────────────────────────────────

async function testC11(): Promise<TestResult> {
  const name = "C11: Agent in multiple protocols";

  try {
    const deployment = loadDeploymentFrom(MULTI_PROTO_DIR);

    const node = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
    const rc = new ReagentController({ nodeId: "multi-proto", agentNode: node });

    // ClientAgent plays TaskProcessing.client
    const { roleIR: clientRole } = loadRoleIR(MULTI_PROTO_DIR, "ClientAgent");
    rc.registerAgent("ClientAgent", clientRole, new Map([
      ["TaskProcessing.client", loadGraph(MULTI_PROTO_DIR, "TaskProcessing", "client")],
    ]));

    // MonitorAgent plays HealthCheck.monitor
    const { roleIR: monitorRole } = loadRoleIR(MULTI_PROTO_DIR, "MonitorAgent");
    rc.registerAgent("MonitorAgent", monitorRole, new Map([
      ["HealthCheck.monitor", loadGraph(MULTI_PROTO_DIR, "HealthCheck", "monitor")],
    ]));

    // WorkerAgent plays BOTH TaskProcessing.worker AND HealthCheck.worker
    const { roleIR: workerRole } = loadRoleIR(MULTI_PROTO_DIR, "WorkerAgent");
    rc.registerAgent("WorkerAgent", workerRole, new Map([
      ["TaskProcessing.worker", loadGraph(MULTI_PROTO_DIR, "TaskProcessing", "worker")],
      ["HealthCheck.worker", loadGraph(MULTI_PROTO_DIR, "HealthCheck", "worker")],
    ]));

    await rc.start();

    // Trigger both protocols — receivers (worker) before senders (client, monitor)
    // to ensure instances are created before messages arrive via loopback
    const taskId = randomUUID();
    const healthId = randomUUID();

    rc.triggerProtocol("WorkerAgent", {
      instanceId: taskId,
      protocolName: "TaskProcessing",
      input: {},
      roleToAgent: deployment.roleToAgent,
    });
    rc.triggerProtocol("WorkerAgent", {
      instanceId: healthId,
      protocolName: "HealthCheck",
      input: {},
      roleToAgent: deployment.roleToAgent,
    });

    rc.triggerProtocol("ClientAgent", {
      instanceId: taskId,
      protocolName: "TaskProcessing",
      input: {},
      roleToAgent: deployment.roleToAgent,
    });
    rc.triggerProtocol("MonitorAgent", {
      instanceId: healthId,
      protocolName: "HealthCheck",
      input: {},
      roleToAgent: deployment.roleToAgent,
    });

    const client = getHandle(rc, "ClientAgent");
    const monitor = getHandle(rc, "MonitorAgent");
    const worker = getHandle(rc, "WorkerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      monitor.waitForCompletion(1, 10000),
      worker.waitForCompletion(2, 10000),  // worker completes both protocols
    ]);

    // Verify both protocols completed on the worker
    const taskInstance = worker.getInstances().get(taskId)!;
    const healthInstance = worker.getInstances().get(healthId)!;

    if (taskInstance.getStatus() !== "completed") return { name, passed: false, error: `Worker TaskProcessing: ${taskInstance.getStatus()}` };
    if (healthInstance.getStatus() !== "completed") return { name, passed: false, error: `Worker HealthCheck: ${healthInstance.getStatus()}` };

    // Verify $self is shared across both protocol instances
    const workerSelf = worker.getSelf();
    if (workerSelf.tasksProcessed !== 1) return { name, passed: false, error: `Expected tasksProcessed=1, got ${workerSelf.tasksProcessed}` };
    if (workerSelf.healthChecks !== 1) return { name, passed: false, error: `Expected healthChecks=1, got ${workerSelf.healthChecks}` };

    // Verify lifecycle handlers fired for each protocol
    if (workerSelf.taskCompletions !== 1) return { name, passed: false, error: `Expected taskCompletions=1, got ${workerSelf.taskCompletions}` };
    if (workerSelf.healthCompletions !== 1) return { name, passed: false, error: `Expected healthCompletions=1, got ${workerSelf.healthCompletions}` };

    // Verify client got the task result
    const clientSelf = client.getSelf();
    if (clientSelf.lastResult !== "done:42") return { name, passed: false, error: `Expected lastResult="done:42", got ${clientSelf.lastResult}` };

    // Verify monitor got the pong
    const monitorSelf = monitor.getSelf();
    const lastPong = monitorSelf.lastPong as any;
    if (lastPong?.status !== "ok") return { name, passed: false, error: `Expected pong status="ok", got ${lastPong?.status}` };

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── C12: Cross-language TS<->Python via RC ──────────────────────────

async function testC12(): Promise<TestResult> {
  const name = "C12: Cross-language TS<->Python via RC";

  try {
    const deployment = loadDeploymentFrom(CROSS_LANG_DIR);

    // Two AgentNode backends — ts and py
    const tsNode = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
    const pyNode = new PythonAgentNode({
      roleToAgent: deployment.roleToAgent,
      pyRuntimeDir: PY_RUNTIME_DIR,
    });

    const rc = new ReagentController({
      nodeId: "cross-lang-node",
      agentNodes: { ts: tsNode, py: pyNode },
    });

    // TsAgent (lang: "ts") → NativeAgentNode
    const { roleIR: tsRole } = loadRoleIR(CROSS_LANG_DIR, "TsAgent");
    const tsGraphs = new Map([
      ["CrossLangE2E.tsRole", loadGraph(CROSS_LANG_DIR, "CrossLangE2E", "tsRole")],
    ]);
    rc.registerAgent("TsAgent", tsRole, tsGraphs);

    // PyAgent (lang: "py") → PythonAgentNode
    const { roleIR: pyRole } = loadRoleIR(CROSS_LANG_DIR, "PyAgent");
    const pyGraphs = new Map([
      ["CrossLangE2E.pyRole", loadGraph(CROSS_LANG_DIR, "CrossLangE2E", "pyRole")],
    ]);
    rc.registerAgent("PyAgent", pyRole, pyGraphs);

    await rc.start();

    const instanceId = randomUUID();
    const trigger = {
      instanceId,
      protocolName: "CrossLangE2E",
      input: {},
      roleToAgent: deployment.roleToAgent,
    };

    // Trigger receiver (PyAgent) before sender (TsAgent) for loopback safety
    rc.triggerProtocol("PyAgent", trigger);
    // Small delay to let the Python side create the protocol instance
    await new Promise(r => setTimeout(r, 200));
    rc.triggerProtocol("TsAgent", trigger);

    const tsHandle = getHandle(rc, "TsAgent");
    const pyHandle = rc.getAgent("PyAgent") as PythonAgentHandle;

    await Promise.all([
      tsHandle.waitForCompletion(1, 15000),
      pyHandle.waitForCompletion(1, 15000),
    ]);

    // Verify TS side completed
    const tsInstance = tsHandle.getInstances().get(instanceId)!;
    if (tsInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `TsAgent: ${tsInstance.getStatus()}` };
    }

    // Verify Python side completed
    const pyStatus = pyHandle.getInstanceStatus(instanceId);
    if (pyStatus !== "completed") {
      return { name, passed: false, error: `PyAgent status: ${pyStatus}` };
    }

    // Verify TS agent got the reply from Python
    const tsSelf = tsHandle.getSelf();
    const expectedReply = "hello from ts — echoed by py";
    if (tsSelf.lastReply !== expectedReply) {
      return { name, passed: false, error: `Expected lastReply="${expectedReply}", got "${tsSelf.lastReply}"` };
    }

    // Verify Python agent's $self via fetchSelf
    const pySelf = await pyHandle.fetchSelf();
    if (pySelf.messagesProcessed !== 1) {
      return { name, passed: false, error: `Expected messagesProcessed=1, got ${pySelf.messagesProcessed}` };
    }
    if (pySelf.completedCount !== 1) {
      return { name, passed: false, error: `Expected completedCount=1, got ${pySelf.completedCount}` };
    }

    await rc.stop();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log("=== M5-CTRL Functional E2E Tests ===\n");

  const tests = [testC1, testC2, testC3, testC4, testC5, testC6, testC7, testC8, testC9, testC10, testC11, testC12];
  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await test();
    results.push(result);

    const mark = result.passed ? "✓" : "✗";
    console.log(`  ${mark} ${result.name}${result.error ? ` — ${result.error}` : ""}`);
  }

  console.log();
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length}`);

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error("Test runner fatal:", err);
  process.exit(1);
});
