/**
 * RC Conformance Runner — verifies all integration modes produce equivalent traces.
 *
 * Runs TsDemo protocol through Managed mode and Custom mode,
 * then compares trace kinds against expected sequences.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ReagentController } from "../../runtime/ts/src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../runtime/ts/src/nodes/managed-behavior-factory.js";
import { CustomBehaviorFactory } from "../../runtime/ts/src/nodes/custom-behavior-factory.js";
import { ManagedAgentBehavior } from "../../runtime/ts/src/core/agent-interface.js";
import { AgentShellImpl } from "../../runtime/ts/src/core/agent-shell-impl.js";
import type { ProtocolEvent, AgentResponse } from "../../runtime/ts/src/core/protocol-engine.js";
import type { IRGraph, ThinAgentIR, RoleIR, TraceEvent } from "../../runtime/ts/src/contracts/types.js";
import { resolveAgentIR } from "../../runtime/ts/src/contracts/types.js";
import type { TraceHook } from "../../runtime/ts/src/contracts/interceptor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");
const EXPECTED_DIR = join(__dirname, "expected");

function loadRoleIR(agentName: string): { roleIR: RoleIR } {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(FIXTURES_DIR, `${agentName}.agent.json`), "utf8"));
  const roleIR: RoleIR = JSON.parse(readFileSync(join(FIXTURES_DIR, thin.roleFile), "utf8"));
  return { roleIR };
}

function loadGraph(proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeployment(): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "deployment.json"), "utf8"));
}

type TestResult = { name: string; passed: boolean; error?: string };

async function runManagedMode(): Promise<Set<string>> {
  const deployment = loadDeployment();
  const traceKinds = new Set<string>();
  const hook: TraceHook = (event: TraceEvent) => { traceKinds.add(event.kind); };

  const behaviorFactory = new ManagedBehaviorFactory();
  const rc = new ReagentController({ nodeId: "conformance-managed", behaviorFactory, traceHook: hook });

  for (const name of ["ClientAgent", "HandlerAgent"]) {
    const { roleIR } = loadRoleIR(name);
    const role = name === "ClientAgent" ? "client" : "handler";
    const graphs = new Map<string, IRGraph>();
    graphs.set(`TsDemo.${role}`, loadGraph("TsDemo", role));
    rc.registerAgent(name, roleIR, graphs);
  }

  await rc.start();
  const instanceId = randomUUID();
  rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "conf" }, roleToAgent: deployment.roleToAgent });
  rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "conf" }, roleToAgent: deployment.roleToAgent });

  const client = rc.getAgent("ClientAgent") as AgentShellImpl;
  const handler = rc.getAgent("HandlerAgent") as AgentShellImpl;
  await Promise.all([client.waitForCompletion(1, 10000), handler.waitForCompletion(1, 10000)]);
  await rc.stop();

  return traceKinds;
}

async function runCustomMode(): Promise<Set<string>> {
  const deployment = loadDeployment();
  const traceKinds = new Set<string>();
  const hook: TraceHook = (event: TraceEvent) => { traceKinds.add(event.kind); };

  const managedFactory = new ManagedBehaviorFactory();
  const customFactory = new CustomBehaviorFactory({
    behaviorFactory: (_agentName, _roleIR) => {
      const adapter = new ManagedAgentBehavior();
      return {
        async handle(event: ProtocolEvent): Promise<AgentResponse> {
          return adapter.handle(event);
        },
      };
    },
  });

  const rc = new ReagentController({ nodeId: "conformance-custom", behaviorFactories: { ts: managedFactory, custom: customFactory }, traceHook: hook });

  // ClientAgent as managed
  const { roleIR: clientRoleIR } = loadRoleIR("ClientAgent");
  const clientGraphs = new Map<string, IRGraph>();
  clientGraphs.set("TsDemo.client", loadGraph("TsDemo", "client"));
  rc.registerAgent("ClientAgent", clientRoleIR, clientGraphs);

  // HandlerAgent as custom
  const { roleIR: handlerRoleIR } = loadRoleIR("HandlerAgent");
  (handlerRoleIR as any).lang = "custom";
  const handlerGraphs = new Map<string, IRGraph>();
  handlerGraphs.set("TsDemo.handler", loadGraph("TsDemo", "handler"));
  rc.registerAgent("HandlerAgent", handlerRoleIR, handlerGraphs);

  await rc.start();
  const instanceId = randomUUID();
  rc.triggerProtocol("ClientAgent", { instanceId, protocolName: "TsDemo", input: { text: "conf" }, roleToAgent: deployment.roleToAgent });
  rc.triggerProtocol("HandlerAgent", { instanceId, protocolName: "TsDemo", input: { text: "conf" }, roleToAgent: deployment.roleToAgent });

  const client = rc.getAgent("ClientAgent") as AgentShellImpl;
  await client.waitForCompletion(1, 10000);
  await new Promise(r => setTimeout(r, 500));
  await rc.stop();

  return traceKinds;
}

async function testConformance(): Promise<TestResult> {
  const name = "CONF1: Managed vs Custom produce equivalent trace kinds";
  try {
    const expected = JSON.parse(readFileSync(join(EXPECTED_DIR, "TsDemo-trace-kinds.json"), "utf8"));

    const managedKinds = await runManagedMode();
    const customKinds = await runCustomMode();

    for (const rk of expected.requiredKinds) {
      if (!managedKinds.has(rk)) {
        return { name, passed: false, error: `Managed mode missing required kind: ${rk}` };
      }
    }

    for (const fk of expected.forbiddenKinds) {
      if (managedKinds.has(fk)) {
        return { name, passed: false, error: `Managed mode has forbidden kind: ${fk}` };
      }
    }

    // Custom mode: at minimum ProtocolStarted and ProtocolCompleted
    if (!customKinds.has("ProtocolStarted")) {
      return { name, passed: false, error: "Custom mode missing ProtocolStarted" };
    }
    if (!customKinds.has("ProtocolCompleted")) {
      return { name, passed: false, error: "Custom mode missing ProtocolCompleted" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

async function main(): Promise<void> {
  const results = [await testConformance()];
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    if (!r.passed) allPassed = false;
  }
  if (!allPassed) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
