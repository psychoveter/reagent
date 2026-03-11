/**
 * Wave 2.2: Custom Agent + Message Gate tests.
 *
 * CA1: Custom agent handles action events via handle()
 * CA2: Custom agent integrates with RC via CustomAgentNode
 * GA1: GateSession validates FSM state
 * GA2: GateSession rejects events after completion
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ReagentController } from "../ts/src/controller/reagent-controller.js";
import { NativeAgentNode, NativeAgentHandle } from "../ts/src/nodes/native-agent-node.js";
import { CustomAgentNode, CustomAgentHandle } from "../ts/src/nodes/custom-agent-node.js";
import { GateSession, GateValidationError } from "../ts/src/gate/gate-session.js";
import { ManagedAgentAdapter } from "../ts/src/core/agent-interface.js";
import type { AgentInterface } from "../ts/src/core/agent-interface.js";
import type { ProtocolEvent, AgentResponse } from "../ts/src/core/protocol-engine.js";
import type { AgentIR, IRGraph, ThinAgentIR, RoleIR, TraceEvent } from "../ts/src/contracts/types.js";
import { resolveAgentIR } from "../ts/src/contracts/types.js";
import type { GateTransport } from "../ts/src/gate/gate-transport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "14-ts-only-demo");

type TestResult = { name: string; passed: boolean; error?: string };

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

// ── CA1: ManagedAgentAdapter handles action events ──────────────────

async function testCA1(): Promise<TestResult> {
  const name = "CA1: ManagedAgentAdapter handles action events";
  try {
    const adapter = new ManagedAgentAdapter();

    const ctx: Record<string, unknown> = { x: 1 };
    const selfRef: Record<string, unknown> = {};

    const response = await adapter.handle({
      type: "action",
      stateId: "test_1",
      body: "$ctx.x = $ctx.x + 10",
      lang: "ts",
      isAsync: false,
      ctx,
      self: selfRef,
    });

    if (response.type !== "ctx_update") {
      return { name, passed: false, error: `Expected ctx_update, got ${response.type}` };
    }
    if ((response as any).ctx.x !== 11) {
      return { name, passed: false, error: `Expected x=11, got x=${(response as any).ctx.x}` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── CA2: Custom agent integrates with RC ────────────────────────────

async function testCA2(): Promise<TestResult> {
  const name = "CA2: Custom agent integrates with RC via CustomAgentNode";
  try {
    const deployment = loadDeploymentFrom(FIXTURES_DIR);
    const handledEvents: string[] = [];

    // One agent is custom, other is native (managed)
    const nativeNode = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });

    const customNode = new CustomAgentNode({
      roleToAgent: deployment.roleToAgent,
      agentFactory: (_agentName, _roleIR) => {
        const adapter = new ManagedAgentAdapter();
        return {
          async handle(event: ProtocolEvent): Promise<AgentResponse> {
            handledEvents.push(event.type);
            return adapter.handle(event);
          },
        };
      },
    });

    // HandlerAgent is custom, ClientAgent is native
    const rc = new ReagentController({
      nodeId: "custom-test-node",
      agentNodes: { ts: nativeNode, custom: customNode },
    });

    // Register ClientAgent on native node (lang "ts" maps to native node key)
    const { roleIR: clientRoleIR } = loadRoleIR(FIXTURES_DIR, "ClientAgent");
    const clientGraphs = new Map<string, IRGraph>();
    clientGraphs.set("TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client"));
    rc.registerAgent("ClientAgent", clientRoleIR, clientGraphs);

    // Register HandlerAgent on custom node (override lang to match node key)
    const { roleIR: handlerRoleIR } = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
    (handlerRoleIR as any).lang = "custom";
    const handlerGraphs = new Map<string, IRGraph>();
    handlerGraphs.set("TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler"));
    rc.registerAgent("HandlerAgent", handlerRoleIR, handlerGraphs);

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "custom test" }, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "custom test" }, roleToAgent: deployment.roleToAgent });

    const clientHandle = rc.getAgent("ClientAgent") as NativeAgentHandle;
    await clientHandle.waitForCompletion(1, 10000);

    // Wait a bit for custom handler to process
    await new Promise(r => setTimeout(r, 500));
    await rc.stop();

    if (handledEvents.length === 0) {
      return { name, passed: false, error: "Custom agent handle() was never called" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── GA1: GateSession validates FSM state ────────────────────────────

async function testGA1(): Promise<TestResult> {
  const name = "GA1: GateSession validates FSM state";
  try {
    const receivedEvents: ProtocolEvent[] = [];
    let responseCallback: ((resp: AgentResponse) => void) | null = null;

    const mockTransport: GateTransport = {
      send(event: ProtocolEvent) {
        receivedEvents.push(event);
        // Auto-respond after a short delay
        setTimeout(() => responseCallback?.({ type: "noop" }), 10);
      },
      onResponse(handler) { responseCallback = handler; },
      close() {},
    };

    const session = new GateSession({
      sessionId: "test-session-1",
      agentName: "TestAgent",
      protocolName: "TestProto",
      transport: mockTransport,
    });

    if (session.getStatus() !== "idle") {
      return { name, passed: false, error: `Expected idle status, got ${session.getStatus()}` };
    }

    await session.sendAndWait({ type: "protocol_started", protocolName: "TestProto" }, 5000);

    if (session.getStatus() !== "active") {
      return { name, passed: false, error: `Expected active status, got ${session.getStatus()}` };
    }

    if (receivedEvents.length !== 1) {
      return { name, passed: false, error: `Expected 1 event, got ${receivedEvents.length}` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── GA2: GateSession rejects events after completion ────────────────

async function testGA2(): Promise<TestResult> {
  const name = "GA2: GateSession rejects events after completion";
  try {
    let responseCallback: ((resp: AgentResponse) => void) | null = null;

    const mockTransport: GateTransport = {
      send() {
        setTimeout(() => responseCallback?.({ type: "noop" }), 10);
      },
      onResponse(handler) { responseCallback = handler; },
      close() {},
    };

    const session = new GateSession({
      sessionId: "test-session-2",
      agentName: "TestAgent",
      protocolName: "TestProto",
      transport: mockTransport,
    });

    // Send completion event
    await session.sendAndWait({
      type: "protocol_completed",
      ctx: {},
    }, 5000);

    if (session.getStatus() !== "completed") {
      return { name, passed: false, error: `Expected completed status, got ${session.getStatus()}` };
    }

    // Attempting to send after completion should fail FSM validation
    try {
      await session.sendAndWait({ type: "protocol_started", protocolName: "TestProto" }, 1000);
      return { name, passed: false, error: "Should have thrown GateValidationError" };
    } catch (err: any) {
      if (err instanceof GateValidationError) {
        return { name, passed: true };
      }
      if (err.message.includes("error state")) {
        return { name, passed: true };
      }
      return { name, passed: false, error: `Unexpected error: ${err.message}` };
    }
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([testCA1(), testCA2(), testGA1(), testGA2()]);
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    if (!r.passed) allPassed = false;
  }
  if (!allPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
