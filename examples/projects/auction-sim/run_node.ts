#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ManagedBehaviorFactory,
  ReagentController,
  DebugAdvanceHook,
  NodeControlEndpoint,
  EtcdStateStore,
  bootstrapRuntime,
  type RuntimeConfig,
  type IRGraph,
  type RoleIR,
  type TraceEvent,
} from "../../../runtime/ts/src/index.js";
import { InMemoryStateStore } from "../../../runtime/ts/src/cluster/state-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const OUT_DIR = join(PROJECT_ROOT, "out");

type DeploymentPlan = {
  agents: Array<{
    agentName: string;
    lang: string;
    roleName: string;
    roleIRFile: string;
    roles: Array<{ protocolName: string; roleName: string; irGraphFile: string }>;
  }>;
  roleToAgent: Record<string, string | string[]>;
};

function parseArgs(): { runtimeConfigPath: string; autoDeploy: boolean } {
  const args = process.argv.slice(2);
  let runtimeConfigPath = join(PROJECT_ROOT, "node.runtime.json");
  let autoDeploy = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runtime-config" && args[i + 1]) {
      runtimeConfigPath = resolve(PROJECT_ROOT, args[++i]);
    } else if (args[i] === "--auto-deploy") {
      autoDeploy = true;
    }
  }
  return { runtimeConfigPath, autoDeploy };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadRuntimeConfig(path: string): RuntimeConfig {
  return readJson<RuntimeConfig>(path);
}

function loadDeployment(): DeploymentPlan {
  return readJson<DeploymentPlan>(join(OUT_DIR, "deployment.json"));
}

function buildAgentGraphs(agentDef: DeploymentPlan["agents"][number]): Map<string, IRGraph> {
  const graphs = new Map<string, IRGraph>();
  for (const binding of agentDef.roles) {
    const graph = readJson<IRGraph>(join(OUT_DIR, binding.irGraphFile));
    graphs.set(`${binding.protocolName}.${binding.roleName}`, graph);
  }
  return graphs;
}

async function main(): Promise<void> {
  const { runtimeConfigPath, autoDeploy } = parseArgs();
  const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);
  const deployment = loadDeployment();

  const stateStore = runtimeConfig.stateStore.kind === "etcd"
    ? new EtcdStateStore({ hosts: runtimeConfig.stateStore.hosts })
    : new InMemoryStateStore();

  let controlEndpoint: NodeControlEndpoint | null = null;
  const debugHooks = new Map<string, DebugAdvanceHook>();
  const debugState = new Map<string, Record<string, unknown>>();

  const traceHook = (event: TraceEvent) => {
    controlEndpoint?.emit("TraceEvent", event as unknown as Record<string, unknown>);
  };

  const rc = new ReagentController({
    nodeId: runtimeConfig.nodeId,
    behaviorFactory: new ManagedBehaviorFactory(),
    traceHook,
    stateStore,
    triggerPolicies: runtimeConfig.triggerPolicies,
    cronIntervalMs: runtimeConfig.cronIntervalMs,
  });

  const runtime = await bootstrapRuntime(runtimeConfig, rc, { stateStore });
  await rc.start();

  const deployProject = async (
    incomingDeployment: DeploymentPlan,
    roleIRs: Record<string, unknown>,
    irGraphs: Record<string, unknown>,
  ): Promise<string[]> => {
    const deployedAgents: string[] = [];
    for (const agentDef of incomingDeployment.agents) {
      if (agentDef.lang !== "ts") continue;
      if (rc.getAgentRecord(agentDef.agentName)) {
        await rc.destroyAgent(agentDef.agentName);
      }
      const roleIR = (roleIRs[agentDef.roleName] ?? roleIRs[`${agentDef.roleName}.role`]) as RoleIR | undefined;
      if (!roleIR) continue;
      const graphs = new Map<string, IRGraph>();
      for (const binding of agentDef.roles) {
        const key = `${binding.protocolName}.${binding.roleName}`;
        const graph = irGraphs[key] as IRGraph | undefined;
        if (graph) graphs.set(key, graph);
      }
      if (graphs.size === 0) continue;
      rc.deployAgentTemplate(agentDef.agentName, roleIR, graphs, {
        protocolName: agentDef.roles[0]?.protocolName ?? "",
      });
      rc.createAgentFromTemplate(agentDef.agentName, { start: true });
      deployedAgents.push(agentDef.agentName);
    }
    return deployedAgents;
  };

  const inspectNode = (): Record<string, unknown> => {
    const inspect = rc.inspect();
    const agents = [...rc.getAgentRecords()].map(([name, record]) => ({
      name,
      lang: record.runtime?.runtimeName ?? "ts",
      route: record.runtime?.nodeId ? `local (${record.runtime.nodeId})` : `declared (${runtimeConfig.nodeId})`,
    }));
    const protocols = rc.listProtocols().map((entry) => ({
      name: entry.name,
      version: entry.version,
      agents: entry.boundAgents,
      graphs: [...entry.irGraphs.keys()],
    }));
    return {
      nodeId: runtimeConfig.nodeId,
      agents,
      protocols,
      routing: inspect.routing,
      agentNodes: [runtimeConfig.nodeId],
      projectedState: inspect,
    };
  };

  const installDebugHook = (sessionId: string, breakpoints: string[]): DebugAdvanceHook => {
    const existing = debugHooks.get(sessionId);
    if (existing) {
      if (breakpoints.length > 0) {
        existing.setStateBreakpoints(breakpoints);
      }
      return existing;
    }

    const hook = new DebugAdvanceHook();
    if (breakpoints.length > 0) {
      hook.setStateBreakpoints(breakpoints);
      hook.setStepMode("none");
    } else {
      hook.setStepMode("stepState");
    }
    hook.setOnEvent((event) => {
      const payload = {
        sessionId,
        level: "state",
        agentName: event.agentName,
        stateId: event.stateId,
        stateKind: event.stateKind,
        instanceId: event.instanceId,
        protocolName: event.protocolName,
        roleName: event.roleName,
        ctx: event.ctx,
        self: event.self,
        reason: event.reason,
      };
      debugState.set(sessionId, payload);
      console.log(`[auction-sim-node] debug stopped session=${sessionId} state=${event.stateId} role=${event.roleName} reason=${event.reason}`);
      controlEndpoint?.emit("Stopped", payload);
    });
    debugHooks.set(sessionId, hook);
    rc.setAdvanceHook(hook.asAdvanceHook());
    return hook;
  };

  controlEndpoint = new NodeControlEndpoint({
    host: runtimeConfig.controlEndpoint?.host ?? "127.0.0.1",
    port: runtimeConfig.controlEndpoint?.port ?? 0,
    handler: async (op, payload) => {
      switch (op) {
        case "InspectNode":
          return inspectNode();
        case "DeployProject": {
          const deployedAgents = await deployProject(
            payload.deployment as DeploymentPlan,
            (payload.roleIRs ?? {}) as Record<string, unknown>,
            (payload.irGraphs ?? {}) as Record<string, unknown>,
          );
          return { nodeId: runtimeConfig.nodeId, deployedAgents };
        }
        case "TriggerProtocol": {
          const agentName = String(payload.agentName ?? "");
          const protocolName = String(payload.protocolName ?? "");
          const instanceId = String(payload.instanceId ?? `${protocolName}-${Date.now()}`);
          const mode = payload.mode as string | undefined;
          const sessionId = payload.sessionId as string | undefined;
          const breakpoints = (payload.breakpoints as string[]) ?? [];
          if (mode === "debug" && sessionId) {
            installDebugHook(sessionId, breakpoints);
          }
          console.log(`[auction-sim-node] trigger agent=${agentName} protocol=${protocolName} mode=${mode ?? "run"} session=${sessionId ?? "-"}`);
          rc.triggerProtocol(agentName, {
            agentName,
            protocolName,
            instanceId,
            input: (payload.input as Record<string, unknown>) ?? {},
            roleToAgent: deployment.roleToAgent,
          } as any);
          return { nodeId: runtimeConfig.nodeId, accepted: true, instanceId };
        }
        case "DebugCommand": {
          const sessionId = String(payload.sessionId ?? "");
          const command = String(payload.command ?? "");
          const hook = debugHooks.get(sessionId);
          if (!hook) return { acknowledged: false };
          switch (command) {
            case "continue":
              hook.continue();
              break;
            case "stepState":
            case "stepIntoScatter":
            case "stepIntoInvoke":
              hook.stepState();
              break;
            case "stepOver":
            case "stepOverScatter":
            case "stepOverInvoke":
              hook.stepOver();
              break;
            case "stepOutScatter":
            case "stepOutInvoke":
              hook.continue();
              break;
            case "stop":
              hook.continue();
              debugHooks.delete(sessionId);
              rc.setAdvanceHook(undefined);
              break;
            case "setBreakpoints":
              hook.setStateBreakpoints((payload.breakpoints as string[]) ?? []);
              break;
          }
          return { acknowledged: true };
        }
        case "SetBreakpointsRequest": {
          const sessionId = String(payload.sessionId ?? "");
          const breakpoints = ((payload.breakpoints as Array<{ stateId?: string }>) ?? [])
            .map((bp) => bp.stateId)
            .filter((bp): bp is string => !!bp);
          installDebugHook(sessionId, breakpoints);
          return { sessionId, breakpoints };
        }
        case "GetState": {
          const sessionId = String(payload.sessionId ?? "");
          return debugState.get(sessionId) ?? { sessionId };
        }
        case "GetDeployedIR": {
          const protocolName = payload.protocolName as string | undefined;
          if (!protocolName) {
            return {
              nodeId: runtimeConfig.nodeId,
              protocols: rc.listProtocols().map((entry) => ({ name: entry.name, version: entry.version })),
            };
          }
          const protocol = rc.listProtocols().find((entry) => entry.name === protocolName);
          return {
            nodeId: runtimeConfig.nodeId,
            protocolName,
            irGraphs: protocol ? Object.fromEntries([...protocol.irGraphs.entries()]) : {},
          };
        }
        case "StoreGet": {
          const value = await runtime.stateStore.get(String(payload.key ?? ""));
          return { value: typeof value === "string" ? value : value?.toString("utf8") ?? null };
        }
        case "StoreList": {
          const entries = await runtime.stateStore.list(String(payload.prefix ?? "/"));
          return {
            entries: entries.map((entry) => ({
              key: entry.key,
              value: typeof entry.value === "string" ? entry.value : entry.value.toString("utf8"),
            })),
          };
        }
        default:
          throw new Error(`Unsupported op: ${op}`);
      }
    },
  });

  const boundPort = await controlEndpoint.start();
  const advertisedControlUrl = runtimeConfig.controlEndpoint?.advertiseUrl
    ?? `ws://${runtimeConfig.controlEndpoint?.host ?? "127.0.0.1"}:${boundPort}`;

  if (runtime.membership) {
    await runtime.membership.updateNodeMetadata({
      control: { kind: "ws", url: advertisedControlUrl },
      capabilities: {
        deploy: true,
        inspect: true,
        trigger: true,
        debug: true,
        trace: true,
        stateStoreProxy: true,
      },
      metadata: {
        langs: runtimeConfig.langs ?? ["ts"],
      },
    });
  }

  console.log(`[auction-sim-node] control endpoint listening at ${advertisedControlUrl}`);

  if (autoDeploy) {
    const deployedAgents = await deployProject(
      deployment,
      Object.fromEntries(
        deployment.agents.map((agentDef) => [
          agentDef.roleName,
          readJson<RoleIR>(join(OUT_DIR, agentDef.roleIRFile)),
        ]),
      ),
      Object.fromEntries(
        deployment.agents.flatMap((agentDef) =>
          agentDef.roles.map((binding) => [
            `${binding.protocolName}.${binding.roleName}`,
            readJson<IRGraph>(join(OUT_DIR, binding.irGraphFile)),
          ]),
        ),
      ),
    );
    console.log(`[auction-sim-node] managed agents started: ${deployedAgents.join(", ")}`);
  } else {
    console.log("[auction-sim-node] node ready; waiting for DeployProject");
  }

  const shutdown = async () => {
    console.log("[auction-sim-node] shutting down...");
    await controlEndpoint?.stop();
    await rc.stop();
    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[auction-sim-node] fatal", err);
  process.exit(1);
});
