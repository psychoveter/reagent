/**
 * Wave 1.2: OTel integration tests.
 *
 * Verifies that OTel interceptors and trace hooks produce the expected
 * span hierarchy when attached to a ReagentController.
 *
 * Uses an in-memory OTel exporter — no collector needed.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed-behavior-factory.js";
import { AgentShellImpl } from "../../src/core/agent-shell-impl.js";
import { createOTelInterceptor, endInstanceSpan } from "../../src/observability/otel-interceptor.js";
import { createOTelTraceHook } from "../../src/observability/otel-trace-hook.js";
import { buildGraphs, loadDeploymentFrom, loadRoleIR } from "../support/runtime-fixtures.js";
import { failSeriesRun, printSeriesSummary, type TestResult } from "../support/test-output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out", "14-ts-only-demo");

// ── OT1: OTel interceptor creates spans for messages ────────────────

async function testOT1(): Promise<TestResult> {
  const name = "OT1: OTel interceptor creates spans for messages";
  try {
    const capturedSpans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

    const fakeTracer = {
      startSpan(spanName: string, opts?: any, _parentCtx?: any) {
        const span = {
          _name: spanName,
          _attrs: { ...(opts?.attributes ?? {}) },
          setAttribute(k: string, v: unknown) { span._attrs[k] = v; },
          setStatus(_s: any) {},
          end() {
            capturedSpans.push({ name: span._name, attributes: span._attrs });
          },
        };
        return span;
      },
    };

    const interceptor = createOTelInterceptor(fakeTracer as any);

    const deployment = loadDeploymentFrom(FIXTURES_DIR);
    const behaviorFactory = new ManagedBehaviorFactory();

    const rc = new ReagentController({
      nodeId: "otel-test-node",
      behaviorFactory,
      interceptors: [interceptor],
    });

    const agents = [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ];

    for (const agentDef of agents) {
      const { roleIR } = loadRoleIR(FIXTURES_DIR, agentDef.name);
      rc.registerAgent(agentDef.name, roleIR, buildGraphs(FIXTURES_DIR, agentDef.graphEntries));
    }

    await rc.start();

    const instanceId = randomUUID();
    const triggerInput = { text: "hello" };
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: triggerInput, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: triggerInput, roleToAgent: deployment.roleToAgent });

    const clientHandle = rc.getAgent("ClientAgent") as AgentShellImpl;
    const handlerHandle = rc.getAgent("HandlerAgent") as AgentShellImpl;
    await Promise.all([
      clientHandle.waitForCompletion(1, 10000),
      handlerHandle.waitForCompletion(1, 10000),
    ]);
    await rc.stop();

    const messageSpans = capturedSpans.filter(
      (s) => s.attributes["reagent.message"] !== undefined
    );

    if (messageSpans.length === 0) {
      return { name, passed: false, error: "No message spans created by OTel interceptor" };
    }

    const hasDirection = messageSpans.every(
      (s) => s.attributes["reagent.direction"] !== undefined
    );
    if (!hasDirection) {
      return { name, passed: false, error: "Message spans missing direction attribute" };
    }

    const hasProtocol = messageSpans.every(
      (s) => s.attributes["reagent.protocol"] === "TsDemo"
    );
    if (!hasProtocol) {
      return { name, passed: false, error: "Message spans missing or wrong protocol attribute" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── OT2: OTel trace hook captures TraceEvent kinds ──────────────────

async function testOT2(): Promise<TestResult> {
  const name = "OT2: OTel trace hook captures TraceEvent kinds";
  try {
    const capturedSpans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

    const fakeTracer = {
      startSpan(spanName: string, opts?: any) {
        const span = {
          _name: spanName,
          _attrs: { ...(opts?.attributes ?? {}) },
          setAttribute(k: string, v: unknown) { span._attrs[k] = v; },
          setStatus(_s: any) {},
          end() {
            capturedSpans.push({ name: span._name, attributes: span._attrs });
          },
        };
        return span;
      },
    };

    const traceHook = createOTelTraceHook(fakeTracer as any);

    const deployment = loadDeploymentFrom(FIXTURES_DIR);
    const behaviorFactory = new ManagedBehaviorFactory();

    const rc = new ReagentController({ nodeId: "otel-trace-node", behaviorFactory, traceHook });

    const agents = [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ];

    for (const agentDef of agents) {
      const { roleIR } = loadRoleIR(FIXTURES_DIR, agentDef.name);
      rc.registerAgent(agentDef.name, roleIR, buildGraphs(FIXTURES_DIR, agentDef.graphEntries));
    }

    await rc.start();

    const instanceId = randomUUID();
    const triggerInput = { text: "hello" };
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: triggerInput, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: triggerInput, roleToAgent: deployment.roleToAgent });

    const clientHandle = rc.getAgent("ClientAgent") as AgentShellImpl;
    const handlerHandle = rc.getAgent("HandlerAgent") as AgentShellImpl;
    await Promise.all([
      clientHandle.waitForCompletion(1, 10000),
      handlerHandle.waitForCompletion(1, 10000),
    ]);
    await rc.stop();

    const traceSpans = capturedSpans.filter((s) => s.name.startsWith("trace:"));
    if (traceSpans.length === 0) {
      return { name, passed: false, error: "No trace spans created" };
    }

    const kinds = new Set(traceSpans.map((s) => s.attributes["reagent.kind"]));
    const requiredKinds = ["ProtocolStarted", "ProtocolCompleted"];
    for (const rk of requiredKinds) {
      if (!kinds.has(rk)) {
        return { name, passed: false, error: `Missing required trace kind: ${rk}` };
      }
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── OT3: endInstanceSpan cleans up root span ────────────────────────

async function testOT3(): Promise<TestResult> {
  const name = "OT3: endInstanceSpan cleans up root span";
  try {
    const ended: string[] = [];

    const fakeTracer = {
      startSpan(spanName: string, opts?: any) {
        return {
          _name: spanName,
          _attrs: { ...(opts?.attributes ?? {}) },
          setAttribute() {},
          setStatus() {},
          end() { ended.push(spanName); },
        };
      },
    };

    const traceHook = createOTelTraceHook(fakeTracer as any);
    const interceptor = createOTelInterceptor(fakeTracer as any);

    const deployment = loadDeploymentFrom(FIXTURES_DIR);
    const behaviorFactory = new ManagedBehaviorFactory();

    const rc = new ReagentController({
      nodeId: "otel-end-node",
      behaviorFactory,
      traceHook,
      interceptors: [interceptor],
    });

    const agents = [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ];

    for (const agentDef of agents) {
      const { roleIR } = loadRoleIR(FIXTURES_DIR, agentDef.name);
      rc.registerAgent(agentDef.name, roleIR, buildGraphs(FIXTURES_DIR, agentDef.graphEntries));
    }

    await rc.start();

    const instanceId = randomUUID();
    const triggerInput = { text: "hello" };
    rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: triggerInput, roleToAgent: deployment.roleToAgent });
    rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: triggerInput, roleToAgent: deployment.roleToAgent });

    const clientHandle = rc.getAgent("ClientAgent") as AgentShellImpl;
    const handlerHandle = rc.getAgent("HandlerAgent") as AgentShellImpl;
    await Promise.all([
      clientHandle.waitForCompletion(1, 10000),
      handlerHandle.waitForCompletion(1, 10000),
    ]);
    await rc.stop();

    const rootSpanEnded = ended.some((n) => n.startsWith("protocol:"));
    if (!rootSpanEnded) {
      return { name, passed: false, error: "Root protocol span was not ended" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([testOT1(), testOT2(), testOT3()]);
  const { failed } = printSeriesSummary(results);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  failSeriesRun(e);
});
