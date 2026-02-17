/**
 * End-to-end functional tests for the Reagent runtime.
 *
 * These tests require a running NATS server at localhost:4222.
 * Start one with: nats-server (or docker run -p 4222:4222 nats)
 *
 * Tests use the TS AgentRunner in-process (no child processes needed).
 * Both agents run in the same Node.js process, communicating via NATS.
 *
 * T1: Linear protocol (accept path)
 * T2: Alt branching — accept path
 * T3: Alt branching — reject path
 * T4: Cross-language (skipped without Python — same IR, same TS runner)
 * T5: Agent $self state across multiple protocol instances
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner, type AgentRunnerConfig } from "../ts/src/agent-runner.js";
import type { AgentIR, IRGraph } from "../ts/src/types.js";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "14-ts-only-demo");

function loadAgentIR(name: string): AgentIR {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.agent.json`), "utf8"));
}

function loadGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "deployment.json"), "utf8"));
}

type TestResult = { name: string; passed: boolean; error?: string };

async function createAgents(): Promise<{ client: AgentRunner; handler: AgentRunner; deployment: { roleToAgent: Record<string, string> } }> {
  const deployment = loadDeployment();

  const clientIR = loadAgentIR("ClientAgent");
  const clientGraph = loadGraph("TsDemo", "client");
  const clientGraphs = new Map<string, IRGraph>();
  clientGraphs.set("TsDemo.client", clientGraph);

  const clientConfig: AgentRunnerConfig = {
    agentIR: clientIR,
    graphs: clientGraphs,
    natsUrl: NATS_URL,
    roleToAgent: deployment.roleToAgent,
  };

  const handlerIR = loadAgentIR("HandlerAgent");
  const handlerGraph = loadGraph("TsDemo", "handler");
  const handlerGraphs = new Map<string, IRGraph>();
  handlerGraphs.set("TsDemo.handler", handlerGraph);

  const handlerConfig: AgentRunnerConfig = {
    agentIR: handlerIR,
    graphs: handlerGraphs,
    natsUrl: NATS_URL,
    roleToAgent: deployment.roleToAgent,
  };

  const client = new AgentRunner(clientConfig);
  const handler = new AgentRunner(handlerConfig);

  await client.start();
  await handler.start();

  // Give subscriptions a moment to establish
  await new Promise(r => setTimeout(r, 300));

  return { client, handler, deployment };
}

async function stopAgents(...agents: AgentRunner[]): Promise<void> {
  for (const a of agents) {
    await a.stop();
  }
}

function triggerProtocol(
  agent: AgentRunner,
  instanceId: string,
  input: Record<string, unknown>,
  roleToAgent: Record<string, string>,
): void {
  const trigger = {
    instanceId,
    protocolName: "TsDemo",
    input,
    roleToAgent,
  };
  agent.getTransport().publish(`reagent.trigger.${agent.agentName}`, trigger);
}

// ── T1: Linear protocol (happy path) ───────────────────────────────

async function testT1(): Promise<TestResult> {
  const name = "T1: Linear protocol (accept path)";
  let client: AgentRunner | null = null;
  let handler: AgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const instanceId = randomUUID();

    // Trigger both agents
    triggerProtocol(client, instanceId, { text: "hello" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, instanceId, { text: "hello" }, agents.deployment.roleToAgent);

    // Wait for both to complete
    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const clientInstance = client.getInstances().get(instanceId);
    const handlerInstance = handler.getInstances().get(instanceId);

    if (!clientInstance || !handlerInstance) {
      return { name, passed: false, error: "Instances not found" };
    }

    if (clientInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `Client status: ${clientInstance.getStatus()}` };
    }
    if (handlerInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `Handler status: ${handlerInstance.getStatus()}` };
    }

    // Verify traces contain expected events
    const clientTraces = clientInstance.getTraces();
    const handlerTraces = handlerInstance.getTraces();

    const clientKinds = clientTraces.map(t => t.kind);
    const handlerKinds = handlerTraces.map(t => t.kind);

    if (!clientKinds.includes("ProtocolStarted")) {
      return { name, passed: false, error: "Missing ProtocolStarted in client traces" };
    }
    if (!clientKinds.includes("ProtocolCompleted")) {
      return { name, passed: false, error: "Missing ProtocolCompleted in client traces" };
    }
    if (!clientKinds.includes("MessageSent")) {
      return { name, passed: false, error: "Missing MessageSent in client traces" };
    }
    if (!handlerKinds.includes("MessageReceived")) {
      return { name, passed: false, error: "Missing MessageReceived in handler traces" };
    }
    if (!handlerKinds.includes("MessageSent")) {
      return { name, passed: false, error: "Missing MessageSent(Accept) in handler traces" };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (client && handler) await stopAgents(client, handler);
  }
}

// ── T2: Alt branching — accept path ────────────────────────────────

async function testT2(): Promise<TestResult> {
  const name = "T2: Alt branching (accept path)";
  let client: AgentRunner | null = null;
  let handler: AgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const instanceId = randomUUID();

    // Input "hello" should trigger status "ok" -> Accept branch
    triggerProtocol(client, instanceId, { text: "hello" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, instanceId, { text: "hello" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const handlerTraces = handler.getInstances().get(instanceId)!.getTraces();
    const sentMessages = handlerTraces
      .filter(t => t.kind === "MessageSent")
      .map(t => t.data?.messageName);

    if (!sentMessages.includes("Accept")) {
      return { name, passed: false, error: `Expected Accept message, got: ${JSON.stringify(sentMessages)}` };
    }
    if (sentMessages.includes("Reject")) {
      return { name, passed: false, error: "Unexpected Reject message in accept path" };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (client && handler) await stopAgents(client, handler);
  }
}

// ── T3: Alt branching — reject path ────────────────────────────────

async function testT3(): Promise<TestResult> {
  const name = "T3: Alt branching (reject path)";
  let client: AgentRunner | null = null;
  let handler: AgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const instanceId = randomUUID();

    // Input "fail" should trigger status "error" -> Reject branch
    triggerProtocol(client, instanceId, { text: "fail" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, instanceId, { text: "fail" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    const handlerTraces = handler.getInstances().get(instanceId)!.getTraces();
    const sentMessages = handlerTraces
      .filter(t => t.kind === "MessageSent")
      .map(t => t.data?.messageName);

    if (!sentMessages.includes("Reject")) {
      return { name, passed: false, error: `Expected Reject message, got: ${JSON.stringify(sentMessages)}` };
    }
    if (sentMessages.includes("Accept")) {
      return { name, passed: false, error: "Unexpected Accept message in reject path" };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (client && handler) await stopAgents(client, handler);
  }
}

// ── T4: Cross-language (TS only simulation) ────────────────────────

async function testT4(): Promise<TestResult> {
  const name = "T4: Cross-language (TS-simulated, same IR format)";
  // This test validates that the IR format is the same regardless of agent language.
  // True cross-language (TS + Python) requires both runtimes + NATS, tested via orchestrator.
  // Here we just verify both agent IRs load and that the fixture format is consistent.

  try {
    const crossDir = join(__dirname, "..", "..", "examples", "out", "13-cross-lang-demo");
    const browserIR: AgentIR = JSON.parse(readFileSync(join(crossDir, "BrowserAgent.agent.json"), "utf8"));
    const serverIR: AgentIR = JSON.parse(readFileSync(join(crossDir, "ServerAgent.agent.json"), "utf8"));

    if (browserIR.lang !== "ts") {
      return { name, passed: false, error: `BrowserAgent lang should be ts, got ${browserIR.lang}` };
    }
    if (serverIR.lang !== "py") {
      return { name, passed: false, error: `ServerAgent lang should be py, got ${serverIR.lang}` };
    }
    if (browserIR.plays.length !== 1 || browserIR.plays[0].protocolName !== "CrossLangDemo") {
      return { name, passed: false, error: "BrowserAgent plays binding incorrect" };
    }
    if (serverIR.plays.length !== 1 || serverIR.plays[0].protocolName !== "CrossLangDemo") {
      return { name, passed: false, error: "ServerAgent plays binding incorrect" };
    }

    // Verify both graphs load
    const browserGraph: IRGraph = JSON.parse(readFileSync(join(crossDir, "CrossLangDemo.browser.ir.json"), "utf8"));
    const serverGraph: IRGraph = JSON.parse(readFileSync(join(crossDir, "CrossLangDemo.server.ir.json"), "utf8"));

    if (browserGraph.role !== "browser") {
      return { name, passed: false, error: "Browser graph role mismatch" };
    }
    if (serverGraph.role !== "server") {
      return { name, passed: false, error: "Server graph role mismatch" };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── T5: Agent $self state across multiple instances ────────────────

async function testT5(): Promise<TestResult> {
  const name = "T5: Agent $self state across sequential instances";
  let client: AgentRunner | null = null;
  let handler: AgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    // Run instance 1
    const id1 = randomUUID();
    triggerProtocol(client, id1, { text: "first" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, id1, { text: "first" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.waitForCompletion(1, 10000),
      handler.waitForCompletion(1, 10000),
    ]);

    // Check $self after first instance
    const handlerSelf1 = handler.getSelf();
    if (handlerSelf1.queriesHandled !== 1) {
      return { name, passed: false, error: `After instance 1: queriesHandled=${handlerSelf1.queriesHandled}, expected 1` };
    }

    const clientSelf1 = client.getSelf();
    if (clientSelf1.responsesReceived !== 1) {
      return { name, passed: false, error: `After instance 1: responsesReceived=${clientSelf1.responsesReceived}, expected 1` };
    }

    // Run instance 2
    const id2 = randomUUID();
    triggerProtocol(client, id2, { text: "second" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, id2, { text: "second" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.waitForCompletion(2, 10000),
      handler.waitForCompletion(2, 10000),
    ]);

    // Check $self after second instance
    const handlerSelf2 = handler.getSelf();
    if (handlerSelf2.queriesHandled !== 2) {
      return { name, passed: false, error: `After instance 2: queriesHandled=${handlerSelf2.queriesHandled}, expected 2` };
    }

    const clientSelf2 = client.getSelf();
    if (clientSelf2.responsesReceived !== 2) {
      return { name, passed: false, error: `After instance 2: responsesReceived=${clientSelf2.responsesReceived}, expected 2` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (client && handler) await stopAgents(client, handler);
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log("=== Reagent Runtime E2E Tests ===\n");
  console.log(`NATS: ${NATS_URL}`);
  console.log(`Fixtures: ${FIXTURES_DIR}\n`);

  const tests = [testT1, testT2, testT3, testT4, testT5];
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
