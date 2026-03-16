/**
 * End-to-end functional tests for the Reagent runtime.
 *
 * These tests require a running NATS server at localhost:4222.
 * Start one with: nats-server (or docker run -p 4222:4222 nats)
 *
 * Tests use the TS AgentShellImpl in-process (no child processes needed).
 * Both agents run in the same Node.js process, communicating via NATS
 * through the NatsCompatTransport shim.
 *
 * T1: Linear protocol (accept path)
 * T2: Alt branching — accept path
 * T3: Alt branching — reject path
 * T4: Cross-language (skipped without Python — same IR, same TS runner)
 * T5: Agent $self state across multiple protocol instances
 * T6: Loop executes N iterations then exits
 * T7: Wait delays execution by specified duration
 * T8: $self accumulates state across loop iterations
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentShellImpl, type AgentShellConfig } from "../../src/core/agent-shell-impl.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed/managed-behavior-factory.js";
import { validateTrace } from "../../src/admin/trace-validator.js";
import type { AgentIR, IRGraph, ThinAgentIR, RoleIR, ProtocolTrigger } from "../../src/contracts/types.js";
import { resolveAgentIR } from "../../src/contracts/types.js";
import { randomUUID } from "node:crypto";
import { exitForSeriesResults, failSeriesRun, type TestResult } from "../support/test-output.js";
import { NatsTransport } from "../../src/network/nats-transport.js";
import { NatsCompatTransport } from "../../src/network/nats-compat-transport.js";
import { normalizeRoleBindingMap } from "../../src/controller/role-bindings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "14-ts-only-demo");
const LOOP_FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "15-loop-and-wait-demo");
const PAR_FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "16-parallel-demo");
const TRYCATCH_FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "17-try-catch-demo");
const INVOKE_FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "18-invoke-demo");
const SPAWN_FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "19-spawn-emit-demo");
const CROSSLANG_FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "20-cross-lang-e2e");
const PY_RUNTIME_DIR = join(__dirname, "..", "..", "..", "py");
const PY_VENV_BIN = join(PY_RUNTIME_DIR, ".venv", "bin", "python");

// ── NATS-backed AgentShell helper ───────────────────────────────────

type NatsAgentRunner = {
  shell: AgentShellImpl;
  nats: NatsTransport;
  compat: NatsCompatTransport;
};

async function createNatsRunner(
  agentIR: AgentIR,
  graphs: Map<string, IRGraph>,
  roleToAgent: Record<string, string>,
): Promise<NatsAgentRunner> {
  const nats = new NatsTransport(NATS_URL);
  await nats.connect();
  const compat = new NatsCompatTransport(agentIR.agentName, nats);

  const shellConfig: AgentShellConfig = {
    agentName: agentIR.agentName,
    roleName: agentIR.roleName,
    agentIR,
    graphs,
    transport: compat,
    roleToAgent: normalizeRoleBindingMap(roleToAgent),
  };
  const shell = new AgentShellImpl(shellConfig);
  const factory = new ManagedBehaviorFactory();
  const behavior = factory.createBehavior(agentIR.agentName, agentIR as any, graphs);
  shell.attachBehavior(behavior);

  compat.subscribeTriggers((data) => {
    shell.triggerProtocol(data as ProtocolTrigger);
  });

  return { shell, nats, compat };
}

async function stopNatsRunners(...runners: NatsAgentRunner[]): Promise<void> {
  for (const r of runners) {
    await r.shell.stop();
    await r.nats.close();
  }
}

function loadAgentIRFromDir(dir: string, name: string): AgentIR {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${name}.agent.json`), "utf8"));
  const role: RoleIR = JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
  return resolveAgentIR(thin, role);
}

function loadAgentIR(name: string): AgentIR {
  return loadAgentIRFromDir(FIXTURES_DIR, name);
}

function loadGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "deployment.json"), "utf8"));
}

async function createAgents(): Promise<{ client: NatsAgentRunner; handler: NatsAgentRunner; deployment: { roleToAgent: Record<string, string> } }> {
  const deployment = loadDeployment();

  const clientIR = loadAgentIR("ClientAgent");
  const clientGraph = loadGraph("TsDemo", "client");
  const clientGraphs = new Map<string, IRGraph>();
  clientGraphs.set("TsDemo.client", clientGraph);

  const handlerIR = loadAgentIR("HandlerAgent");
  const handlerGraph = loadGraph("TsDemo", "handler");
  const handlerGraphs = new Map<string, IRGraph>();
  handlerGraphs.set("TsDemo.handler", handlerGraph);

  const client = await createNatsRunner(clientIR, clientGraphs, deployment.roleToAgent);
  const handler = await createNatsRunner(handlerIR, handlerGraphs, deployment.roleToAgent);

  await client.shell.start();
  await handler.shell.start();

  await new Promise(r => setTimeout(r, 300));

  return { client, handler, deployment };
}

function triggerProtocol(
  runner: NatsAgentRunner,
  instanceId: string,
  input: Record<string, unknown>,
  roleToAgent: Record<string, string>,
): void {
  runner.shell.triggerProtocol({
    instanceId,
    protocolName: "TsDemo",
    input,
    roleToAgent,
  });
}

// ── T1: Linear protocol (happy path) ───────────────────────────────

async function testT1(): Promise<TestResult> {
  const name = "T1: Linear protocol (accept path)";
  let client: NatsAgentRunner | null = null;
  let handler: NatsAgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const instanceId = randomUUID();

    triggerProtocol(client, instanceId, { text: "hello" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, instanceId, { text: "hello" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.shell.waitForCompletion(1, 10000),
      handler.shell.waitForCompletion(1, 10000),
    ]);

    const clientInstance = client.shell.getInstances().get(instanceId);
    const handlerInstance = handler.shell.getInstances().get(instanceId);

    if (!clientInstance || !handlerInstance) {
      return { name, passed: false, error: "Instances not found" };
    }

    if (clientInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `Client status: ${clientInstance.getStatus()}` };
    }
    if (handlerInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `Handler status: ${handlerInstance.getStatus()}` };
    }

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
      return { name, passed: false, error: "Missing MessageSent in handler traces" };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (client && handler) await stopNatsRunners(client, handler);
  }
}

// ── T2: Alt branching — accept path ────────────────────────────────

async function testT2(): Promise<TestResult> {
  const name = "T2: Alt branching (accept path)";
  let client: NatsAgentRunner | null = null;
  let handler: NatsAgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const instanceId = randomUUID();

    triggerProtocol(client, instanceId, { text: "hello" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, instanceId, { text: "hello" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.shell.waitForCompletion(1, 10000),
      handler.shell.waitForCompletion(1, 10000),
    ]);

    const handlerTraces = handler.shell.getInstances().get(instanceId)!.getTraces();
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
    if (client && handler) await stopNatsRunners(client, handler);
  }
}

// ── T3: Alt branching — reject path ────────────────────────────────

async function testT3(): Promise<TestResult> {
  const name = "T3: Alt branching (reject path)";
  let client: NatsAgentRunner | null = null;
  let handler: NatsAgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const instanceId = randomUUID();

    triggerProtocol(client, instanceId, { text: "fail" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, instanceId, { text: "fail" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.shell.waitForCompletion(1, 10000),
      handler.shell.waitForCompletion(1, 10000),
    ]);

    const handlerTraces = handler.shell.getInstances().get(instanceId)!.getTraces();
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
    if (client && handler) await stopNatsRunners(client, handler);
  }
}

// ── T4: Cross-language (TS only simulation) ────────────────────────

async function testT4(): Promise<TestResult> {
  const name = "T4: Cross-language (TS-simulated, same IR format)";

  try {
    const crossDir = join(__dirname, "..", "..", "..", "..", "examples", "out", "13-cross-lang-demo");
    const browserIR = loadAgentIRFromDir(crossDir, "BrowserAgent");
    const serverIR = loadAgentIRFromDir(crossDir, "ServerAgent");

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
  let client: NatsAgentRunner | null = null;
  let handler: NatsAgentRunner | null = null;

  try {
    const agents = await createAgents();
    client = agents.client;
    handler = agents.handler;

    const id1 = randomUUID();
    triggerProtocol(client, id1, { text: "first" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, id1, { text: "first" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.shell.waitForCompletion(1, 10000),
      handler.shell.waitForCompletion(1, 10000),
    ]);

    const handlerSelf1 = handler.shell.getSelf();
    if (handlerSelf1.queriesHandled !== 1) {
      return { name, passed: false, error: `After instance 1: queriesHandled=${handlerSelf1.queriesHandled}, expected 1` };
    }

    const clientSelf1 = client.shell.getSelf();
    if (clientSelf1.responsesReceived !== 1) {
      return { name, passed: false, error: `After instance 1: responsesReceived=${clientSelf1.responsesReceived}, expected 1` };
    }

    const id2 = randomUUID();
    triggerProtocol(client, id2, { text: "second" }, agents.deployment.roleToAgent);
    triggerProtocol(handler, id2, { text: "second" }, agents.deployment.roleToAgent);

    await Promise.all([
      client.shell.waitForCompletion(2, 10000),
      handler.shell.waitForCompletion(2, 10000),
    ]);

    const handlerSelf2 = handler.shell.getSelf();
    if (handlerSelf2.queriesHandled !== 2) {
      return { name, passed: false, error: `After instance 2: queriesHandled=${handlerSelf2.queriesHandled}, expected 2` };
    }

    const clientSelf2 = client.shell.getSelf();
    if (clientSelf2.responsesReceived !== 2) {
      return { name, passed: false, error: `After instance 2: responsesReceived=${clientSelf2.responsesReceived}, expected 2` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (client && handler) await stopNatsRunners(client, handler);
  }
}

// ── Loop/Wait helpers ───────────────────────────────────────────────

function loadLoopAgentIR(name: string): AgentIR {
  return loadAgentIRFromDir(LOOP_FIXTURES_DIR, name);
}

function loadLoopGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(LOOP_FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadLoopDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(LOOP_FIXTURES_DIR, "deployment.json"), "utf8"));
}

async function createLoopAgents(): Promise<{ poller: NatsAgentRunner; responder: NatsAgentRunner; deployment: { roleToAgent: Record<string, string> } }> {
  const deployment = loadLoopDeployment();

  const pollerIR = loadLoopAgentIR("PollerAgent");
  const pollerGraph = loadLoopGraph("LoopWaitDemo", "poller");
  const pollerGraphs = new Map<string, IRGraph>();
  pollerGraphs.set("LoopWaitDemo.poller", pollerGraph);

  const responderIR = loadLoopAgentIR("ResponderAgent");
  const responderGraph = loadLoopGraph("LoopWaitDemo", "responder");
  const responderGraphs = new Map<string, IRGraph>();
  responderGraphs.set("LoopWaitDemo.responder", responderGraph);

  const poller = await createNatsRunner(pollerIR, pollerGraphs, deployment.roleToAgent);
  const responder = await createNatsRunner(responderIR, responderGraphs, deployment.roleToAgent);

  await poller.shell.start();
  await responder.shell.start();

  await new Promise(r => setTimeout(r, 300));

  return { poller, responder, deployment };
}

function triggerLoopProtocol(
  runner: NatsAgentRunner,
  instanceId: string,
  input: Record<string, unknown>,
  roleToAgent: Record<string, string>,
): void {
  runner.shell.triggerProtocol({
    instanceId,
    protocolName: "LoopWaitDemo",
    input,
    roleToAgent,
  });
}

// ── T6: Loop executes N iterations then exits ───────────────────────

async function testT6(): Promise<TestResult> {
  const name = "T6: Loop executes 3 iterations then exits";
  let poller: NatsAgentRunner | null = null;
  let responder: NatsAgentRunner | null = null;

  try {
    const agents = await createLoopAgents();
    poller = agents.poller;
    responder = agents.responder;

    const instanceId = randomUUID();

    triggerLoopProtocol(poller, instanceId, {}, agents.deployment.roleToAgent);
    triggerLoopProtocol(responder, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      poller.shell.waitForCompletion(1, 15000),
      responder.shell.waitForCompletion(1, 15000),
    ]);

    const pollerInstance = poller.shell.getInstances().get(instanceId);
    const responderInstance = responder.shell.getInstances().get(instanceId);

    if (!pollerInstance || !responderInstance) {
      return { name, passed: false, error: "Instances not found" };
    }

    if (pollerInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `Poller status: ${pollerInstance.getStatus()}` };
    }
    if (responderInstance.getStatus() !== "completed") {
      return { name, passed: false, error: `Responder status: ${responderInstance.getStatus()}` };
    }

    const pollerTraces = pollerInstance.getTraces();
    const pingSent = pollerTraces.filter(t => t.kind === "MessageSent" && t.data?.messageName === "Ping");
    const doneSent = pollerTraces.filter(t => t.kind === "MessageSent" && t.data?.messageName === "Done");

    if (pingSent.length !== 3) {
      return { name, passed: false, error: `Expected 3 Ping sent, got ${pingSent.length}` };
    }
    if (doneSent.length !== 1) {
      return { name, passed: false, error: `Expected 1 Done sent, got ${doneSent.length}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (poller && responder) await stopNatsRunners(poller, responder);
  }
}

// ── T7: Wait delays execution by specified duration ─────────────────

async function testT7(): Promise<TestResult> {
  const name = "T7: Wait delays execution (~300ms)";
  let poller: NatsAgentRunner | null = null;
  let responder: NatsAgentRunner | null = null;

  try {
    const agents = await createLoopAgents();
    poller = agents.poller;
    responder = agents.responder;

    const instanceId = randomUUID();
    const startTime = Date.now();

    triggerLoopProtocol(poller, instanceId, {}, agents.deployment.roleToAgent);
    triggerLoopProtocol(responder, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      poller.shell.waitForCompletion(1, 15000),
      responder.shell.waitForCompletion(1, 15000),
    ]);

    const elapsed = Date.now() - startTime;

    // Protocol has 3 iterations with 100ms wait each = ~300ms minimum
    if (elapsed < 250) {
      return { name, passed: false, error: `Too fast: ${elapsed}ms (expected ≥ 300ms)` };
    }

    // Verify timer traces
    const pollerTraces = poller.shell.getInstances().get(instanceId)!.getTraces();
    const timerStarted = pollerTraces.filter(t => t.kind === "TimerStarted");
    const timerFired = pollerTraces.filter(t => t.kind === "TimerFired");

    if (timerStarted.length !== 3) {
      return { name, passed: false, error: `Expected 3 TimerStarted, got ${timerStarted.length}` };
    }
    if (timerFired.length !== 3) {
      return { name, passed: false, error: `Expected 3 TimerFired, got ${timerFired.length}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (poller && responder) await stopNatsRunners(poller, responder);
  }
}

// ── T8: $self accumulates state across loop iterations ──────────────

async function testT8(): Promise<TestResult> {
  const name = "T8: $self accumulates state across loop iterations";
  let poller: NatsAgentRunner | null = null;
  let responder: NatsAgentRunner | null = null;

  try {
    const agents = await createLoopAgents();
    poller = agents.poller;
    responder = agents.responder;

    const instanceId = randomUUID();

    triggerLoopProtocol(poller, instanceId, {}, agents.deployment.roleToAgent);
    triggerLoopProtocol(responder, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      poller.shell.waitForCompletion(1, 15000),
      responder.shell.waitForCompletion(1, 15000),
    ]);

    // Check poller $self state
    const pollerSelf = poller.shell.getSelf();
    if (pollerSelf.loopCount !== 3) {
      return { name, passed: false, error: `Expected loopCount=3, got ${pollerSelf.loopCount}` };
    }

    // Check responder $self state
    const responderSelf = responder.shell.getSelf();
    if (responderSelf.pingsReceived !== 3) {
      return { name, passed: false, error: `Expected pingsReceived=3, got ${responderSelf.pingsReceived}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (poller && responder) await stopNatsRunners(poller, responder);
  }
}

// ── Par helpers ─────────────────────────────────────────────────────

function loadParAgentIR(name: string): AgentIR {
  return loadAgentIRFromDir(PAR_FIXTURES_DIR, name);
}

function loadParGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(PAR_FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadParDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(PAR_FIXTURES_DIR, "deployment.json"), "utf8"));
}

async function createParAgents(): Promise<{
  coordinator: NatsAgentRunner;
  workerA: NatsAgentRunner;
  workerB: NatsAgentRunner;
  deployment: { roleToAgent: Record<string, string> };
}> {
  const deployment = loadParDeployment();

  const coordIR = loadParAgentIR("CoordinatorAgent");
  const coordGraph = loadParGraph("ParDemo", "coordinator");
  const coordGraphs = new Map<string, IRGraph>([["ParDemo.coordinator", coordGraph]]);

  const workerAIR = loadParAgentIR("WorkerAAgent");
  const workerAGraph = loadParGraph("ParDemo", "workerA");
  const workerAGraphs = new Map<string, IRGraph>([["ParDemo.workerA", workerAGraph]]);

  const workerBIR = loadParAgentIR("WorkerBAgent");
  const workerBGraph = loadParGraph("ParDemo", "workerB");
  const workerBGraphs = new Map<string, IRGraph>([["ParDemo.workerB", workerBGraph]]);

  const coordinator = await createNatsRunner(coordIR, coordGraphs, deployment.roleToAgent);
  const workerA = await createNatsRunner(workerAIR, workerAGraphs, deployment.roleToAgent);
  const workerB = await createNatsRunner(workerBIR, workerBGraphs, deployment.roleToAgent);

  await coordinator.shell.start();
  await workerA.shell.start();
  await workerB.shell.start();
  await new Promise(r => setTimeout(r, 300));

  return { coordinator, workerA, workerB, deployment };
}

function triggerParProtocol(
  runner: NatsAgentRunner,
  instanceId: string,
  input: Record<string, unknown>,
  roleToAgent: Record<string, string>,
): void {
  runner.shell.triggerProtocol({
    instanceId, protocolName: "ParDemo", input, roleToAgent,
  });
}

// ── T9: Par branches both complete, join fires ──────────────────────

async function testT9(): Promise<TestResult> {
  const name = "T9: Par branches both complete, join fires";
  let coordinator: NatsAgentRunner | null = null;
  let workerA: NatsAgentRunner | null = null;
  let workerB: NatsAgentRunner | null = null;

  try {
    const agents = await createParAgents();
    coordinator = agents.coordinator;
    workerA = agents.workerA;
    workerB = agents.workerB;

    const instanceId = randomUUID();
    triggerParProtocol(coordinator, instanceId, {}, agents.deployment.roleToAgent);
    triggerParProtocol(workerA, instanceId, {}, agents.deployment.roleToAgent);
    triggerParProtocol(workerB, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      coordinator.shell.waitForCompletion(1, 10000),
      workerA.shell.waitForCompletion(1, 10000),
      workerB.shell.waitForCompletion(1, 10000),
    ]);

    const ci = coordinator.shell.getInstances().get(instanceId)!;
    const ai = workerA.shell.getInstances().get(instanceId)!;
    const bi = workerB.shell.getInstances().get(instanceId)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Coordinator: ${ci.getStatus()}` };
    if (ai.getStatus() !== "completed") return { name, passed: false, error: `WorkerA: ${ai.getStatus()}` };
    if (bi.getStatus() !== "completed") return { name, passed: false, error: `WorkerB: ${bi.getStatus()}` };

    // Verify join trace
    const coordTraces = ci.getTraces();
    const joinEvents = coordTraces.filter(t => t.kind === "JoinCompleted");
    if (joinEvents.length !== 1) return { name, passed: false, error: `Expected 1 JoinCompleted, got ${joinEvents.length}` };

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (coordinator && workerA && workerB) await stopNatsRunners(coordinator, workerA, workerB);
  }
}

// ── T10: Par with $self accumulation across branches ─────────────────

async function testT10(): Promise<TestResult> {
  const name = "T10: Par $self accumulation across branches";
  let coordinator: NatsAgentRunner | null = null;
  let workerA: NatsAgentRunner | null = null;
  let workerB: NatsAgentRunner | null = null;

  try {
    const agents = await createParAgents();
    coordinator = agents.coordinator;
    workerA = agents.workerA;
    workerB = agents.workerB;

    const instanceId = randomUUID();
    triggerParProtocol(coordinator, instanceId, {}, agents.deployment.roleToAgent);
    triggerParProtocol(workerA, instanceId, {}, agents.deployment.roleToAgent);
    triggerParProtocol(workerB, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      coordinator.shell.waitForCompletion(1, 10000),
      workerA.shell.waitForCompletion(1, 10000),
      workerB.shell.waitForCompletion(1, 10000),
    ]);

    // Coordinator accumulated its own $self
    const coordSelf = coordinator.shell.getSelf();
    if (coordSelf.protocolsCoordinated !== 1) return { name, passed: false, error: `Coord protocols: ${coordSelf.protocolsCoordinated}` };

    // Both workers sent messages
    const aTraces = workerA.shell.getInstances().get(instanceId)!.getTraces();
    const bTraces = workerB.shell.getInstances().get(instanceId)!.getTraces();
    const aSent = aTraces.filter(t => t.kind === "MessageSent").map(t => t.data?.messageName);
    const bSent = bTraces.filter(t => t.kind === "MessageSent").map(t => t.data?.messageName);
    if (!aSent.includes("ResultA")) return { name, passed: false, error: "WorkerA didn't send ResultA" };
    if (!bSent.includes("ResultB")) return { name, passed: false, error: "WorkerB didn't send ResultB" };

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (coordinator && workerA && workerB) await stopNatsRunners(coordinator, workerA, workerB);
  }
}

// ── Try/catch helpers ───────────────────────────────────────────────

function loadTryCatchAgentIR(name: string): AgentIR {
  return loadAgentIRFromDir(TRYCATCH_FIXTURES_DIR, name);
}

function loadTryCatchGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(TRYCATCH_FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadTryCatchDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(TRYCATCH_FIXTURES_DIR, "deployment.json"), "utf8"));
}

async function createTryCatchAgents(): Promise<{
  sender: NatsAgentRunner;
  processor: NatsAgentRunner;
  deployment: { roleToAgent: Record<string, string> };
}> {
  const deployment = loadTryCatchDeployment();

  const senderIR = loadTryCatchAgentIR("SenderAgent");
  const senderGraph = loadTryCatchGraph("TryCatchDemo", "sender");
  const senderGraphs = new Map<string, IRGraph>([["TryCatchDemo.sender", senderGraph]]);

  const procIR = loadTryCatchAgentIR("ProcessorAgent");
  const procGraph = loadTryCatchGraph("TryCatchDemo", "processor");
  const procGraphs = new Map<string, IRGraph>([["TryCatchDemo.processor", procGraph]]);

  const sender = await createNatsRunner(senderIR, senderGraphs, deployment.roleToAgent);
  const processor = await createNatsRunner(procIR, procGraphs, deployment.roleToAgent);

  await sender.shell.start();
  await processor.shell.start();
  await new Promise(r => setTimeout(r, 300));

  return { sender, processor, deployment };
}

function triggerTryCatchProtocol(
  runner: NatsAgentRunner,
  instanceId: string,
  input: Record<string, unknown>,
  roleToAgent: Record<string, string>,
): void {
  runner.shell.triggerProtocol({
    instanceId, protocolName: "TryCatchDemo", input, roleToAgent,
  });
}

// ── T11: Zone throws → catch block executes ─────────────────────────

async function testT11(): Promise<TestResult> {
  const name = "T11: Zone throws → catch block executes";
  let sender: NatsAgentRunner | null = null;
  let processor: NatsAgentRunner | null = null;

  try {
    const agents = await createTryCatchAgents();
    sender = agents.sender;
    processor = agents.processor;

    const instanceId = randomUUID();
    triggerTryCatchProtocol(sender, instanceId, { text: "fail" }, agents.deployment.roleToAgent);
    triggerTryCatchProtocol(processor, instanceId, { text: "fail" }, agents.deployment.roleToAgent);

    await Promise.all([
      sender.shell.waitForCompletion(1, 10000),
      processor.shell.waitForCompletion(1, 10000),
    ]);

    const si = sender.shell.getInstances().get(instanceId)!;
    const pi = processor.shell.getInstances().get(instanceId)!;

    if (si.getStatus() !== "completed") return { name, passed: false, error: `Sender: ${si.getStatus()}` };
    if (pi.getStatus() !== "completed") return { name, passed: false, error: `Processor: ${pi.getStatus()}` };

    const procTraces = pi.getTraces();
    const errorCaught = procTraces.filter(t => t.kind === "ErrorCaught");
    if (errorCaught.length === 0) return { name, passed: false, error: "No ErrorCaught trace in processor" };

    const senderTraces = si.getTraces();
    const senderRecv = senderTraces.filter(t => t.kind === "MessageReceived").map(t => t.data?.messageName);
    if (!senderRecv.includes("ErrorReport")) {
      return { name, passed: false, error: `Sender didn't receive ErrorReport. Received: ${JSON.stringify(senderRecv)}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (sender && processor) await stopNatsRunners(sender, processor);
  }
}

// ── T12: Catch block → error path completes normally ─────────────────

async function testT12(): Promise<TestResult> {
  const name = "T12: Catch block → error path completes normally";
  let sender: NatsAgentRunner | null = null;
  let processor: NatsAgentRunner | null = null;

  try {
    const agents = await createTryCatchAgents();
    sender = agents.sender;
    processor = agents.processor;

    const instanceId = randomUUID();
    triggerTryCatchProtocol(sender, instanceId, { text: "fail" }, agents.deployment.roleToAgent);
    triggerTryCatchProtocol(processor, instanceId, { text: "fail" }, agents.deployment.roleToAgent);

    await Promise.all([
      sender.shell.waitForCompletion(1, 10000),
      processor.shell.waitForCompletion(1, 10000),
    ]);

    const pi = processor.shell.getInstances().get(instanceId)!;
    if (pi.getStatus() !== "completed") return { name, passed: false, error: `Processor: ${pi.getStatus()}` };

    const procTraces = pi.getTraces();
    const completed = procTraces.filter(t => t.kind === "ProtocolCompleted");
    if (completed.length !== 1) return { name, passed: false, error: `Expected 1 ProtocolCompleted, got ${completed.length}` };

    const sentMessages = procTraces.filter(t => t.kind === "MessageSent").map(t => t.data?.messageName);
    if (!sentMessages.includes("ErrorReport")) {
      return { name, passed: false, error: `Processor didn't send ErrorReport. Sent: ${JSON.stringify(sentMessages)}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (sender && processor) await stopNatsRunners(sender, processor);
  }
}

// ── Invoke helpers ──────────────────────────────────────────────────

function loadInvokeAgentIR(name: string): AgentIR {
  return loadAgentIRFromDir(INVOKE_FIXTURES_DIR, name);
}

function loadInvokeGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(INVOKE_FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadInvokeDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(INVOKE_FIXTURES_DIR, "deployment.json"), "utf8"));
}

async function createInvokeAgents(): Promise<{
  caller: NatsAgentRunner;
  responder: NatsAgentRunner;
  deployment: { roleToAgent: Record<string, string> };
}> {
  const deployment = loadInvokeDeployment();

  const callerIR = loadInvokeAgentIR("CallerAgent");
  const callerGraph = loadInvokeGraph("InvokeDemo", "caller");
  const callerGraphs = new Map<string, IRGraph>([["InvokeDemo.caller", callerGraph]]);

  const responderIR = loadInvokeAgentIR("ResponderAgent");
  const responderGraph = loadInvokeGraph("InvokeDemo", "responder");
  const childGraph = loadInvokeGraph("ComputeSquare", "worker");
  const responderGraphs = new Map<string, IRGraph>([
    ["InvokeDemo.responder", responderGraph],
    ["ComputeSquare.worker", childGraph],
  ]);

  const caller = await createNatsRunner(callerIR, callerGraphs, deployment.roleToAgent);
  const responder = await createNatsRunner(responderIR, responderGraphs, deployment.roleToAgent);

  await caller.shell.start();
  await responder.shell.start();
  await new Promise(r => setTimeout(r, 300));

  return { caller, responder, deployment };
}

function triggerInvokeProtocol(
  runner: NatsAgentRunner,
  instanceId: string,
  input: Record<string, unknown>,
  roleToAgent: Record<string, string>,
): void {
  runner.shell.triggerProtocol({
    instanceId, protocolName: "InvokeDemo", input, roleToAgent,
  });
}

// ── T13: reagent.invoke() runs child protocol and returns value ─────

async function testT13(): Promise<TestResult> {
  const name = "T13: reagent.invoke() runs child and returns value";
  let caller: NatsAgentRunner | null = null;
  let responder: NatsAgentRunner | null = null;

  try {
    const agents = await createInvokeAgents();
    caller = agents.caller;
    responder = agents.responder;

    const instanceId = randomUUID();
    triggerInvokeProtocol(caller, instanceId, {}, agents.deployment.roleToAgent);
    triggerInvokeProtocol(responder, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      caller.shell.waitForCompletion(1, 10000),
      responder.shell.waitForCompletion(1, 10000),
    ]);

    const ci = caller.shell.getInstances().get(instanceId)!;
    const ri = responder.shell.getInstances().get(instanceId)!;

    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Caller: ${ci.getStatus()}` };
    if (ri.getStatus() !== "completed") return { name, passed: false, error: `Responder: ${ri.getStatus()}` };

    const callerSelf = caller.shell.getSelf();
    if (callerSelf.lastResult !== 49) {
      return { name, passed: false, error: `Expected lastResult=49, got ${callerSelf.lastResult}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (caller && responder) await stopNatsRunners(caller, responder);
  }
}

// ── T14: invoke return value flows back to caller context ────────────

async function testT14(): Promise<TestResult> {
  const name = "T14: invoke return value flows into caller $ctx";
  let caller: NatsAgentRunner | null = null;
  let responder: NatsAgentRunner | null = null;

  try {
    const agents = await createInvokeAgents();
    caller = agents.caller;
    responder = agents.responder;

    const instanceId = randomUUID();
    triggerInvokeProtocol(caller, instanceId, {}, agents.deployment.roleToAgent);
    triggerInvokeProtocol(responder, instanceId, {}, agents.deployment.roleToAgent);

    await Promise.all([
      caller.shell.waitForCompletion(1, 10000),
      responder.shell.waitForCompletion(1, 10000),
    ]);

    const ci = caller.shell.getInstances().get(instanceId)!;
    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Caller: ${ci.getStatus()}` };

    const callerTraces = ci.getTraces();
    const sent = callerTraces.filter(t => t.kind === "MessageSent").map(t => t.data?.messageName);
    const recv = callerTraces.filter(t => t.kind === "MessageReceived").map(t => t.data?.messageName);
    if (!sent.includes("ComputeRequest")) return { name, passed: false, error: "Caller didn't send ComputeRequest" };
    if (!recv.includes("ComputeResult")) return { name, passed: false, error: "Caller didn't receive ComputeResult" };

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (caller && responder) await stopNatsRunners(caller, responder);
  }
}

// ── Spawn/emit helpers ──────────────────────────────────────────────

function loadSpawnAgentIR(name: string): AgentIR {
  return loadAgentIRFromDir(SPAWN_FIXTURES_DIR, name);
}

function loadSpawnGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(SPAWN_FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadSpawnDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(SPAWN_FIXTURES_DIR, "deployment.json"), "utf8"));
}

async function createSpawnAgents(): Promise<{
  orchestrator: NatsAgentRunner;
  helper: NatsAgentRunner;
  deployment: { roleToAgent: Record<string, string> };
}> {
  const deployment = loadSpawnDeployment();

  const orchIR = loadSpawnAgentIR("OrchestratorAgent");
  const orchGraph = loadSpawnGraph("SpawnEmitDemo", "orchestrator");
  const bgGraph = loadSpawnGraph("BackgroundTask", "worker");
  const orchGraphs = new Map<string, IRGraph>([
    ["SpawnEmitDemo.orchestrator", orchGraph],
    ["BackgroundTask.worker", bgGraph],
  ]);

  const helperIR = loadSpawnAgentIR("HelperAgent");
  const helperGraph = loadSpawnGraph("SpawnEmitDemo", "helper");
  const helperGraphs = new Map<string, IRGraph>([["SpawnEmitDemo.helper", helperGraph]]);

  const orchestrator = await createNatsRunner(orchIR, orchGraphs, deployment.roleToAgent);
  const helper = await createNatsRunner(helperIR, helperGraphs, deployment.roleToAgent);

  await orchestrator.shell.start();
  await helper.shell.start();
  await new Promise(r => setTimeout(r, 300));

  return { orchestrator, helper, deployment };
}

function triggerSpawnProtocol(
  runner: NatsAgentRunner,
  instanceId: string,
  roleToAgent: Record<string, string>,
): void {
  runner.shell.triggerProtocol({
    instanceId, protocolName: "SpawnEmitDemo", input: {}, roleToAgent,
  });
}

// ── T15: Spawn starts child instance, parent continues ──────────────

async function testT15(): Promise<TestResult> {
  const name = "T15: reagent.spawn() starts child, parent continues";
  let orchestrator: NatsAgentRunner | null = null;
  let helper: NatsAgentRunner | null = null;

  try {
    const agents = await createSpawnAgents();
    orchestrator = agents.orchestrator;
    helper = agents.helper;

    const instanceId = randomUUID();
    triggerSpawnProtocol(orchestrator, instanceId, agents.deployment.roleToAgent);
    triggerSpawnProtocol(helper, instanceId, agents.deployment.roleToAgent);

    await Promise.all([
      orchestrator.shell.waitForCompletion(2, 10000),
      helper.shell.waitForCompletion(1, 10000),
    ]);

    const oi = orchestrator.shell.getInstances().get(instanceId)!;
    if (oi.getStatus() !== "completed") return { name, passed: false, error: `Orchestrator main: ${oi.getStatus()}` };

    const orchSelf = orchestrator.shell.getSelf();
    if (orchSelf.spawned !== 1) return { name, passed: false, error: `Expected spawned=1, got ${orchSelf.spawned}` };
    if (orchSelf.bgTasksCompleted !== 1) return { name, passed: false, error: `Expected bgTasksCompleted=1, got ${orchSelf.bgTasksCompleted}` };

    if (orchSelf.lastResult !== "done:compute") return { name, passed: false, error: `Expected lastResult="done:compute", got ${orchSelf.lastResult}` };

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (orchestrator && helper) await stopNatsRunners(orchestrator, helper);
  }
}

// ── T16: Emit triggers agent lifecycle handler ──────────────────────

async function testT16(): Promise<TestResult> {
  const name = "T16: reagent.emit() triggers protocolEvent handler";
  let orchestrator: NatsAgentRunner | null = null;
  let helper: NatsAgentRunner | null = null;

  try {
    const agents = await createSpawnAgents();
    orchestrator = agents.orchestrator;
    helper = agents.helper;

    const instanceId = randomUUID();
    triggerSpawnProtocol(orchestrator, instanceId, agents.deployment.roleToAgent);
    triggerSpawnProtocol(helper, instanceId, agents.deployment.roleToAgent);

    await Promise.all([
      orchestrator.shell.waitForCompletion(2, 10000),
      helper.shell.waitForCompletion(1, 10000),
    ]);

    const hi = helper.shell.getInstances().get(instanceId)!;
    if (hi.getStatus() !== "completed") return { name, passed: false, error: `Helper: ${hi.getStatus()}` };

    const hTraces = hi.getTraces();
    const emitted = hTraces.filter(t => t.kind === "EventEmitted" as any);
    if (emitted.length !== 1) return { name, passed: false, error: `Expected 1 EventEmitted, got ${emitted.length}` };
    if (emitted[0].data?.eventName !== "TaskProcessed") {
      return { name, passed: false, error: `Expected eventName=TaskProcessed, got ${emitted[0].data?.eventName}` };
    }

    const helperSelf = helper.shell.getSelf();
    if (helperSelf.eventsHandled !== 1) {
      return { name, passed: false, error: `Expected eventsHandled=1, got ${helperSelf.eventsHandled}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (orchestrator && helper) await stopNatsRunners(orchestrator, helper);
  }
}

// ── Cross-language helpers ───────────────────────────────────────────

function runPyAgent(
  fixturesDir: string,
  agentName: string,
  instanceId: string,
  roleToAgent: Record<string, string>,
): Promise<{ status: string; self: Record<string, unknown>; traces: any[] }> {
  return new Promise((resolve, reject) => {
    const pyScript = join(__dirname, "..", "python", "py_agent_runner.py");
    const child = spawnProcess(PY_VENV_BIN, [
      pyScript,
      fixturesDir,
      agentName,
      NATS_URL.replace("nats://", "nats://"),
      instanceId,
      JSON.stringify(roleToAgent),
    ], {
      cwd: PY_RUNTIME_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Python agent timed out. stderr: ${stderr}\nstdout: ${stdout}`));
    }, 20000);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Python agent exited ${code}. stderr: ${stderr}\nstdout: ${stdout}`));
        return;
      }
      const lines = stdout.split("\n");
      const resultLine = lines.find(l => l.startsWith("RESULT:"));
      if (!resultLine) {
        reject(new Error(`No RESULT line in stdout: ${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(resultLine.slice(7)));
      } catch (e) {
        reject(new Error(`Failed to parse result: ${resultLine}`));
      }
    });
  });
}

// ── T17: TS → Python → TS message flow ──────────────────────────────

async function testT17(): Promise<TestResult> {
  const name = "T17: Cross-language TS ↔ Python message flow";

  if (!existsSync(PY_VENV_BIN)) {
    return { name, passed: true, error: "(skipped — Python venv not found)" };
  }

  let tsRunner: NatsAgentRunner | null = null;

  try {
    const deployment = JSON.parse(readFileSync(join(CROSSLANG_FIXTURES_DIR, "deployment.json"), "utf8"));
    const tsAgentIR = loadAgentIRFromDir(CROSSLANG_FIXTURES_DIR, "TsAgent");
    const tsGraph: IRGraph = JSON.parse(readFileSync(join(CROSSLANG_FIXTURES_DIR, "CrossLangE2E.tsRole.ir.json"), "utf8"));

    tsRunner = await createNatsRunner(
      tsAgentIR,
      new Map([["CrossLangE2E.tsRole", tsGraph]]),
      deployment.roleToAgent,
    );

    await tsRunner.shell.start();
    await new Promise(r => setTimeout(r, 300));

    const instanceId = randomUUID();

    const pyPromise = runPyAgent(CROSSLANG_FIXTURES_DIR, "PyAgent", instanceId, deployment.roleToAgent);

    await new Promise(r => setTimeout(r, 1500));

    tsRunner.shell.triggerProtocol({
      instanceId,
      protocolName: "CrossLangE2E",
      input: {},
      roleToAgent: deployment.roleToAgent,
    });

    const [pyResult] = await Promise.all([
      pyPromise,
      tsRunner.shell.waitForCompletion(1, 15000),
    ]);

    const tsi = tsRunner.shell.getInstances().get(instanceId)!;
    if (tsi.getStatus() !== "completed") return { name, passed: false, error: `TS: ${tsi.getStatus()}` };
    if (pyResult.status !== "completed") {
      const failTraces = pyResult.traces?.filter((t: any) => t.kind === "ProtocolFailed") ?? [];
      return { name, passed: false, error: `Py: ${pyResult.status}, traces: ${JSON.stringify(failTraces)}` };
    }

    const tsSelf = tsRunner.shell.getSelf();
    const expectedReply = "hello from ts — echoed by py";
    if (tsSelf.lastReply !== expectedReply) {
      return { name, passed: false, error: `Expected lastReply="${expectedReply}", got "${tsSelf.lastReply}"` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (tsRunner) await stopNatsRunners(tsRunner);
  }
}

// ── T18: Python agent $self persists + lifecycle handler ─────────────

async function testT18(): Promise<TestResult> {
  const name = "T18: Python $self state + lifecycle handler";

  if (!existsSync(PY_VENV_BIN)) {
    return { name, passed: true, error: "(skipped — Python venv not found)" };
  }

  let tsRunner: NatsAgentRunner | null = null;

  try {
    const deployment = JSON.parse(readFileSync(join(CROSSLANG_FIXTURES_DIR, "deployment.json"), "utf8"));
    const tsAgentIR = loadAgentIRFromDir(CROSSLANG_FIXTURES_DIR, "TsAgent");
    const tsGraph: IRGraph = JSON.parse(readFileSync(join(CROSSLANG_FIXTURES_DIR, "CrossLangE2E.tsRole.ir.json"), "utf8"));

    tsRunner = await createNatsRunner(
      tsAgentIR,
      new Map([["CrossLangE2E.tsRole", tsGraph]]),
      deployment.roleToAgent,
    );

    await tsRunner.shell.start();
    await new Promise(r => setTimeout(r, 300));

    const instanceId = randomUUID();

    const pyPromise = runPyAgent(CROSSLANG_FIXTURES_DIR, "PyAgent", instanceId, deployment.roleToAgent);

    await new Promise(r => setTimeout(r, 1500));

    tsRunner.shell.triggerProtocol({
      instanceId,
      protocolName: "CrossLangE2E",
      input: {},
      roleToAgent: deployment.roleToAgent,
    });

    const [pyResult] = await Promise.all([
      pyPromise,
      tsRunner.shell.waitForCompletion(1, 15000),
    ]);

    if (pyResult.self.messagesProcessed !== 1) {
      return { name, passed: false, error: `Expected messagesProcessed=1, got ${pyResult.self.messagesProcessed}` };
    }

    if (pyResult.self.completedCount !== 1) {
      return { name, passed: false, error: `Expected completedCount=1, got ${pyResult.self.completedCount}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  } finally {
    if (tsRunner) await stopNatsRunners(tsRunner);
  }
}

// ── T19: Trace validator detects illegal message ─────────────────────

async function testT19(): Promise<TestResult> {
  const name = "T19: Trace validator detects illegal message";

  try {
    const graph: IRGraph = JSON.parse(readFileSync(join(FIXTURES_DIR, "TsDemo.client.ir.json"), "utf8"));

    const legalTraces = [
      { instanceId: "x", eventId: "1", kind: "ProtocolStarted", ts: 1, agent: "A", data: {} },
      { instanceId: "x", eventId: "2", kind: "MessageSent", ts: 2, agent: "A", data: { messageName: "Query" } },
      { instanceId: "x", eventId: "3", kind: "MessageReceived", ts: 3, agent: "A", data: { messageName: "Accept" } },
      { instanceId: "x", eventId: "4", kind: "ProtocolCompleted", ts: 4, agent: "A", data: {} },
    ] as any[];

    const legalResult = validateTrace(graph, legalTraces);
    if (!legalResult.valid) {
      return { name, passed: false, error: `Legal trace was rejected: ${JSON.stringify(legalResult.diagnostics)}` };
    }

    const illegalTraces = [
      { instanceId: "x", eventId: "1", kind: "ProtocolStarted", ts: 1, agent: "A", data: {} },
      { instanceId: "x", eventId: "2", kind: "MessageSent", ts: 2, agent: "A", data: { messageName: "Query" } },
      { instanceId: "x", eventId: "3", kind: "MessageReceived", ts: 3, agent: "A", data: { messageName: "ILLEGAL_MESSAGE" } },
      { instanceId: "x", eventId: "4", kind: "ProtocolCompleted", ts: 4, agent: "A", data: {} },
    ] as any[];

    const illegalResult = validateTrace(graph, illegalTraces);
    if (illegalResult.valid) {
      return { name, passed: false, error: "Illegal trace was accepted — validator should detect the illegal message" };
    }

    const hasIllegalDiag = illegalResult.diagnostics.some(d =>
      d.level === "error" && d.message.includes("ILLEGAL_MESSAGE"),
    );
    if (!hasIllegalDiag) {
      return { name, passed: false, error: `Validator didn't flag ILLEGAL_MESSAGE: ${JSON.stringify(illegalResult.diagnostics)}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── T20: Trace validator detects incomplete trace ────────────────────

async function testT20(): Promise<TestResult> {
  const name = "T20: Trace validator detects incomplete trace";

  try {
    const graph: IRGraph = JSON.parse(readFileSync(join(FIXTURES_DIR, "TsDemo.client.ir.json"), "utf8"));

    const incompleteTraces = [
      { instanceId: "x", eventId: "1", kind: "ProtocolStarted", ts: 1, agent: "A", data: {} },
      { instanceId: "x", eventId: "2", kind: "MessageSent", ts: 2, agent: "A", data: { messageName: "Query" } },
    ] as any[];

    const result = validateTrace(graph, incompleteTraces);

    const hasNoCompletion = result.diagnostics.some(d =>
      d.level === "error" && d.message.includes("no completion event"),
    );
    if (!hasNoCompletion) {
      return { name, passed: false, error: `Validator didn't flag missing completion: ${JSON.stringify(result.diagnostics)}` };
    }

    if (result.valid) {
      return { name, passed: false, error: "Incomplete trace was accepted — should be invalid" };
    }

    const noStartTraces = [
      { instanceId: "x", eventId: "2", kind: "MessageSent", ts: 2, agent: "A", data: { messageName: "Query" } },
      { instanceId: "x", eventId: "3", kind: "MessageReceived", ts: 3, agent: "A", data: { messageName: "Accept" } },
      { instanceId: "x", eventId: "4", kind: "ProtocolCompleted", ts: 4, agent: "A", data: {} },
    ] as any[];

    const noStartResult = validateTrace(graph, noStartTraces);
    const hasMissingStart = noStartResult.diagnostics.some(d =>
      d.level === "error" && d.message.includes("missing ProtocolStarted"),
    );
    if (!hasMissingStart) {
      return { name, passed: false, error: `Validator didn't flag missing ProtocolStarted: ${JSON.stringify(noStartResult.diagnostics)}` };
    }

    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: String(e) };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log("=== Reagent Runtime E2E Tests ===\n");
  console.log(`NATS: ${NATS_URL}`);
  console.log(`Fixtures: ${FIXTURES_DIR}\n`);

  const tests = [testT1, testT2, testT3, testT4, testT5, testT6, testT7, testT8, testT9, testT10, testT11, testT12, testT13, testT14, testT15, testT16, testT17, testT18, testT19, testT20];
  const results: TestResult[] = [];

  for (const test of tests) {
    results.push(await test());
  }

  exitForSeriesResults(results);
}

runAllTests().catch(err => {
  failSeriesRun(err);
});
