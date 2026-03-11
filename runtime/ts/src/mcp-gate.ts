#!/usr/bin/env node
/**
 * mcp-gate — standalone MCP server subprocess for Reagent protocol participation.
 *
 * Usage:
 *   node mcp-gate.js --node-id my-agent \
 *     --nats-url nats://localhost:4222 --etcd-hosts http://127.0.0.1:2379
 *
 *   node mcp-gate.js \
 *     --runtime-config ./human.runtime.json
 *
 * This process:
 *   1. Bootstraps cluster (connects to etcd for agent discovery)
 *   2. Publishes a node control endpoint via shared cluster state
 *   3. Uses CustomAgentNode + McpAgentAdapter (zones go to MCP client)
 *   4. Creates NatsNodeLinks lazily when remote agents are discovered via etcd
 *   5. Exposes Reagent MCP tools on stdio (JSON-RPC via stdin/stdout)
 *
 * The agent (Claude Code, Cursor) starts this process as an MCP server subprocess:
 *   { "command": "node", "args": ["mcp-gate.js", "--node-id", "claude-1", ...] }
 */

import { readFileSync } from "node:fs";
import { ReagentController } from "./controller/reagent-controller.js";
import { CustomAgentNode } from "./nodes/custom-agent-node.js";
import { McpAgentAdapter } from "./mcp/mcp-agent-adapter.js";
import { ReagentMcpServer } from "./mcp/mcp-server.js";
import { NatsNodeLink } from "./network/nats-node-link.js";
import type { IRGraph, RoleIR } from "./contracts/types.js";
import type { LegacyRoleBindingMap, RoleBindingMap } from "./controller/role-bindings.js";
import { mergeRoleBindings } from "./controller/role-bindings.js";
import { createDefaultRuntimeConfig, type RuntimeConfig } from "./cluster/runtime-config.js";
import { bootstrapRuntime } from "./cluster/runtime-bootstrap.js";
import { EtcdStateStore } from "./cluster/etcd-state-store.js";
import { InMemoryStateStore } from "./cluster/state-store.js";
import { NodeControlEndpoint } from "./admin/node-control-endpoint.js";
import { DebugAdvanceHook } from "./admin/debug-advance-hook.js";

// ── CLI args ─────────────────────────────────────────────────────────

interface GateArgs {
  nodeId?: string;
  langs?: string[];
  natsUrl?: string;
  etcdHosts?: string[];
  runtimeConfigPath?: string;
}

function parseArgs(): GateArgs {
  const args = process.argv.slice(2);
  let nodeId: string | undefined;
  let langs: string[] | undefined;
  let natsUrl: string | undefined;
  let etcdHosts: string[] | undefined;
  let runtimeConfigPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--admin-url" && args[i + 1]) ++i;
    else if (args[i] === "--node-id" && args[i + 1]) nodeId = args[++i];
    else if (args[i] === "--langs" && args[i + 1]) langs = args[++i].split(",");
    else if (args[i] === "--nats-url" && args[i + 1]) natsUrl = args[++i];
    else if (args[i] === "--etcd-hosts" && args[i + 1]) etcdHosts = args[++i].split(",");
    else if (args[i] === "--runtime-config" && args[i + 1]) runtimeConfigPath = args[++i];
  }

  return { nodeId, langs, natsUrl, etcdHosts, runtimeConfigPath };
}

function loadRuntimeConfig(path: string): RuntimeConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid runtime config at ${path}`);
  }
  return raw;
}

function resolveRuntimeConfig(args: GateArgs): { runtimeConfig: RuntimeConfig } {
  const fileConfig = args.runtimeConfigPath ? loadRuntimeConfig(args.runtimeConfigPath) : undefined;
  const nodeId = args.nodeId ?? fileConfig?.nodeId ?? `mcp-gate-${process.pid}`;
  const baseConfig = createDefaultRuntimeConfig(nodeId);

  if (!fileConfig) {
    return {
      runtimeConfig: {
        ...baseConfig,
        nodeId,
        langs: args.langs ?? ["ts"],
        stateStore: { kind: "etcd", hosts: args.etcdHosts ?? ["http://127.0.0.1:2379"] },
        membership: { enabled: true },
        messagePlane: { kind: "nats", url: args.natsUrl ?? "nats://localhost:4222" },
        controlEndpoint: { enabled: true, host: "127.0.0.1", port: 0 },
      },
    };
  }

  return {
    runtimeConfig: {
      ...baseConfig,
      ...fileConfig,
      nodeId,
      langs: args.langs ?? fileConfig.langs ?? baseConfig.langs,
      stateStore: args.etcdHosts
        ? { kind: "etcd", hosts: args.etcdHosts }
        : (fileConfig.stateStore ?? baseConfig.stateStore),
      messagePlane: args.natsUrl
        ? { kind: "nats", url: args.natsUrl }
        : (fileConfig.messagePlane ?? baseConfig.messagePlane),
      membership: fileConfig.membership ?? baseConfig.membership,
      telemetry: fileConfig.telemetry ?? baseConfig.telemetry,
      controlEndpoint: fileConfig.controlEndpoint ?? { enabled: true, host: "127.0.0.1", port: 0 },
      triggerPolicies: fileConfig.triggerPolicies ?? baseConfig.triggerPolicies,
      cronIntervalMs: fileConfig.cronIntervalMs ?? baseConfig.cronIntervalMs,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const { runtimeConfig } = resolveRuntimeConfig(args);
  const nodeId = runtimeConfig.nodeId;
  const langs = runtimeConfig.langs ?? ["ts"];
  const startedAt = new Date().toISOString();

  const log = (msg: string) => process.stderr.write(`[mcp-gate ${nodeId}] ${msg}\n`);

  // ── RC setup ──

  const adapter = new McpAgentAdapter(nodeId);
  const roleToAgent: RoleBindingMap = {};
  const debugHooks = new Map<string, DebugAdvanceHook>();
  const debugState = new Map<string, Record<string, unknown>>();
  const resolveConfiguredAgent = (protocolName: string, roleName: string) => roleToAgent[`${protocolName}.${roleName}`];
  const natsUrl = runtimeConfig.messagePlane?.kind === "nats" ? runtimeConfig.messagePlane.url : undefined;
  const stateStore = runtimeConfig.stateStore.kind === "etcd"
    ? new EtcdStateStore({ hosts: runtimeConfig.stateStore.hosts })
    : new InMemoryStateStore();

  const mcpNode = new CustomAgentNode({
    roleToAgent: resolveConfiguredAgent,
    agentFactory: () => adapter,
  });

  const agentNodes: Record<string, typeof mcpNode> = {};
  for (const lang of langs) agentNodes[lang] = mcpNode;

  const rc = new ReagentController({
    nodeId,
    agentNodes,
    stateStore,
    triggerPolicies: runtimeConfig.triggerPolicies,
  });

  // ── Etcd membership with lazy NatsNodeLink creation ──

  const createdLinks = new Map<string, NatsNodeLink>();

  const ensureLink = async (remoteNodeId: string): Promise<void> => {
    if (createdLinks.has(remoteNodeId)) return;
    if (!natsUrl) {
      throw new Error("NATS node links require messagePlane.kind = \"nats\"");
    }
    const link = new NatsNodeLink({ localNodeId: nodeId, remoteNodeId, natsUrl });
    await link.connect();
    rc.addNodeLink(link);
    createdLinks.set(remoteNodeId, link);
    log(`NatsNodeLink created for remote node: ${remoteNodeId}`);
  };

  const runtime = await bootstrapRuntime(runtimeConfig, rc, {
    stateStore,
    onRemoteAgent: async (agentName, remoteNodeId) => {
      try {
        if (!natsUrl) {
          throw new Error("remote agent discovery requires messagePlane.kind = \"nats\"");
        }
        await ensureLink(remoteNodeId);
        rc.registerRemoteAgent(agentName, remoteNodeId);
        log(`Discovered remote agent: ${agentName} on ${remoteNodeId}`);
      } catch (err) {
        log(`Failed to set up link for ${remoteNodeId}: ${err}`);
      }
    },
    onRemoteAgentRemoved: (agentName) => {
      log(`Remote agent removed: ${agentName}`);
    },
    onNodeJoin: (nid) => {
      log(`Node joined: ${nid}`);
    },
    onNodeLeave: async (nid) => {
      log(`Node left: ${nid}`);
      const link = createdLinks.get(nid);
      if (link) {
        await link.close();
        createdLinks.delete(nid);
      }
    },
  });
  if (runtimeConfig.stateStore.kind === "etcd") {
    log(`Connected to state store at ${runtimeConfig.stateStore.hosts.join(",")}`);
  } else {
    log("Connected to in-memory state store");
  }

  function buildNodeInspect(): Record<string, unknown> {
    const agents = [...rc.getAgentRecords()].map(([name, record]) => ({
      name,
      lang: record.runtime?.runtimeName ?? "ts",
      route: record.runtime?.nodeId ? `local (${record.runtime.nodeId})` : `declared (${nodeId})`,
    }));

    const protocols: Array<{ name: string; version: string; agents: string[]; graphs: string[] }> = [];
    const seenProtos = new Set<string>();
    for (const [agentName, handle] of rc.getRegisteredAgents()) {
      const graphs = (handle as any).graphs as Map<string, unknown> | undefined;
      if (graphs) {
        for (const key of graphs.keys()) {
          const parts = key.split(".");
          const protoName = parts[0];
          if (!seenProtos.has(protoName)) {
            seenProtos.add(protoName);
            protocols.push({ name: protoName, version: "1.0", agents: [agentName], graphs: [key] });
          }
        }
      }
    }

    const routing = Object.fromEntries(
      Object.entries(roleToAgent).map(([key, value]) => [key, value.agents.join(",")]),
    );

    return {
      nodeId,
      agents,
      protocols,
      routing,
      agentNodes: [nodeId],
      projectedState: {
        routing: rc.inspect().routing,
      },
    };
  }

  function handleDeployProject(payload: Record<string, unknown>): Record<string, unknown> {
    const deployment = payload.deployment as {
      agents: Array<{
        agentName: string;
        lang: string;
        roleName: string;
        roles: Array<{ protocolName: string; roleName: string }>;
      }>;
      roleToAgent: LegacyRoleBindingMap;
    } | undefined;
    const roleIRs = (payload.roleIRs ?? {}) as Record<string, unknown>;
    const irGraphs = (payload.irGraphs ?? {}) as Record<string, unknown>;
    const agentRegistrations = (payload.agentRegistrations ?? {}) as Record<string, { tags?: string[]; capabilities?: string[]; labels?: Record<string, string> }>;

    if (!deployment) {
      throw new Error("Missing deployment payload");
    }

    const deployedAgents: string[] = [];
    for (const agentDef of deployment.agents) {
      if (!langs.includes(agentDef.lang)) {
        continue;
      }

      const roleIR = (roleIRs[agentDef.roleName] ?? roleIRs[`${agentDef.roleName}.role`]) as RoleIR | undefined;
      if (!roleIR) {
        continue;
      }

      const graphs = new Map<string, IRGraph>();
      for (const binding of agentDef.roles) {
        const key = `${binding.protocolName}.${binding.roleName}`;
        if (irGraphs[key]) {
          graphs.set(key, irGraphs[key] as IRGraph);
        }
      }
      if (graphs.size === 0) continue;

      for (const graph of graphs.values()) {
        mergeRoleBindings(graph.protocolName, roleToAgent, deployment.roleToAgent);
      }

      const extras = agentRegistrations[agentDef.agentName] ?? {};
      const template = rc.deployAgentTemplate(agentDef.agentName, roleIR, graphs, extras);
      rc.createAgentRecord(agentDef.agentName, roleIR, template.templateId, {
        ...extras,
        protocolName: agentDef.roles[0]?.protocolName ?? "",
      });
      if (adapter.isRegistered() && adapter.agentName === agentDef.agentName && !rc.hasAgent(agentDef.agentName)) {
        rc.createAgentFromTemplate(agentDef.agentName);
      }
      deployedAgents.push(agentDef.agentName);
      log(`Deployed agent template and record: ${agentDef.agentName}`);
    }

    return { nodeId, deployedAgents };
  }

  function handleTrigger(payload: Record<string, unknown>): Record<string, unknown> {
    const agentName = payload.agentName as string;
    const protocolName = payload.protocolName as string;
    const instanceId = (payload.instanceId as string | undefined) ?? `${protocolName}-${Date.now()}`;
    const input = (payload.input as Record<string, unknown>) ?? {};
    const rta = mergeRoleBindings(protocolName, {}, (payload.roleToAgent as LegacyRoleBindingMap) ?? roleToAgent);
    const mode = payload.mode as string | undefined;
    const sessionId = payload.sessionId as string | undefined;

    if (mode === "debug" && sessionId) {
      const breakpoints = (payload.breakpoints as string[]) ?? [];
      installDebugHook(sessionId, breakpoints);
    }
    rc.triggerProtocol(agentName, { instanceId, protocolName, input, roleToAgent: rta });
    log(`Triggered: ${protocolName} instance=${instanceId} agent=${agentName}`);
    return { nodeId, agentName, protocolName, instanceId };
  }

  function installDebugHook(sessionId: string, breakpoints: string[]): void {
    if (debugHooks.has(sessionId)) return;
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
      controlEndpoint.emit("Stopped", payload);
    });
    debugHooks.set(sessionId, hook);
    rc.setAdvanceHook(hook.asAdvanceHook());
  }

  function handleDebugCommand(payload: Record<string, unknown>): Record<string, unknown> {
    const sessionId = payload.sessionId as string;
    const command = payload.command as string;
    const hook = debugHooks.get(sessionId);
    if (!hook) return { sessionId, acknowledged: false };

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
    return { sessionId, acknowledged: true };
  }

  function handleSetBreakpoints(payload: Record<string, unknown>): Record<string, unknown> {
    const sessionId = payload.sessionId as string;
    const breakpoints = ((payload.breakpoints as Array<{ stateId?: string }>) ?? [])
      .map((bp) => bp.stateId)
      .filter((bp): bp is string => !!bp);
    const hook = debugHooks.get(sessionId);
    if (hook) {
      hook.setStateBreakpoints(breakpoints);
    } else {
      installDebugHook(sessionId, breakpoints);
    }
    return {
      sessionId,
      breakpoints,
    };
  }

  function handleGetState(payload: Record<string, unknown>): Record<string, unknown> {
    const sessionId = payload.sessionId as string;
    return debugState.get(sessionId) ?? { sessionId };
  }

  function handleStopAgent(payload: Record<string, unknown>): Record<string, unknown> {
    const agentName = payload.agentName as string;
    rc.detachAgentRuntime(agentName);
    return { nodeId, agentName, stopped: true };
  }

  function handleGetDeployedIR(payload: Record<string, unknown>): Record<string, unknown> {
    const protocolName = payload.protocolName as string | undefined;
    if (!protocolName) {
      return {
        nodeId,
        protocols: rc.listProtocols().map((entry) => ({
          name: entry.name,
          version: entry.version,
        })),
      };
    }
    const matching = rc.listProtocols().find((entry) => entry.name === protocolName);
    return {
      nodeId,
      protocolName,
      irGraphs: matching ? Object.fromEntries([...matching.irGraphs.entries()]) : {},
    };
  }

  function encodeStoreValue(value: string | Buffer | null): string | null {
    if (value == null) return null;
    return typeof value === "string" ? value : value.toString("utf8");
  }

  const controlEndpoint = new NodeControlEndpoint({
    host: runtimeConfig.controlEndpoint?.host ?? "127.0.0.1",
    port: runtimeConfig.controlEndpoint?.port ?? 0,
    handler: async (op, payload) => {
      switch (op) {
        case "InspectNode":
          return buildNodeInspect();
        case "DeployProject":
          return handleDeployProject(payload);
        case "TriggerProtocol":
          return handleTrigger(payload);
        case "DebugCommand":
          return handleDebugCommand(payload);
        case "SetBreakpointsRequest":
          return handleSetBreakpoints(payload);
        case "GetState":
          return handleGetState(payload);
        case "StopAgent":
          return handleStopAgent(payload);
        case "GetDeployedIR":
          return handleGetDeployedIR(payload);
        case "StoreGet": {
          const key = payload.key as string;
          return { value: encodeStoreValue(await runtime.stateStore.get(key)) };
        }
        case "StoreList": {
          const prefix = (payload.prefix as string) ?? "/";
          const entries = await runtime.stateStore.list(prefix);
          return {
            entries: entries.map((entry) => ({
              key: entry.key,
              value: encodeStoreValue(entry.value) ?? "",
            })),
          };
        }
        case "GetProjectedState":
          return {
            nodeId,
            inspect: rc.inspect(),
          };
        default:
          throw new Error(`Unsupported node control op: ${op}`);
      }
    },
  });
  const boundControlPort = await controlEndpoint.start();
  const advertisedControlUrl = runtimeConfig.controlEndpoint?.advertiseUrl
    ?? `ws://${runtimeConfig.controlEndpoint?.host ?? "127.0.0.1"}:${boundControlPort}`;

  if (runtime.membership) {
    await runtime.membership.updateNodeMetadata({
      control: { kind: "ws", url: advertisedControlUrl },
      capabilities: {
        deploy: true,
        inspect: true,
        trigger: true,
        stateStoreProxy: true,
      },
      metadata: {
        langs,
      },
    });
  } else {
    await runtime.stateStore.put(`/nodes/${nodeId}`, JSON.stringify({
      nodeId,
      startedAt,
      control: { kind: "ws", url: advertisedControlUrl },
      capabilities: {
        deploy: true,
        inspect: true,
        trigger: true,
        stateStoreProxy: true,
      },
      metadata: {
        langs,
      },
    }));
  }

  log(`Node control endpoint listening at ${advertisedControlUrl}`);

  // ── Start MCP server on stdio ──

  const mcpServer = new ReagentMcpServer({
    adapter,
    onRegister: async (agentName, roles) => {
      const result = adapter.register(agentName, roles);
      if (rc.getAgentRecord(agentName) && !rc.hasAgent(agentName)) {
        rc.createAgentFromTemplate(agentName);
      } else {
        rc.markAgentRuntimeReady(agentName);
      }
      return result;
    },
    onUnregister: async (agentName) => {
      if (agentName) {
        rc.detachAgentRuntime(agentName);
      }
    },
    onInvoke: async (protocolName, input, roleBindings) => {
      const invoked = rc.invokeProtocol(
        protocolName,
        input,
        { roleToAgent: mergeRoleBindings(protocolName, {}, roleBindings ?? roleToAgent) },
      );
      if (!invoked) {
        throw new Error(`Unable to invoke protocol ${protocolName} on node ${nodeId}`);
      }
      return invoked.instanceId;
    },
    listProtocols: () => rc.listProtocols().map((entry) => ({
      name: entry.name,
      version: entry.version,
      roles: [...new Set([...entry.irGraphs.values()].map((graph) => graph.role))],
      description: `${entry.name} runtime deployment`,
    })),
    listInstances: (agentName) => {
      const handle = rc.getAgent(agentName);
      const instances = typeof (handle as any)?.getInstances === "function"
        ? (handle as any).getInstances()
        : new Map();
      return [...instances.keys()].map((instanceId) => ({
        instanceId,
        protocolName: (instances.get(instanceId) as any)?.protocolName ?? "unknown",
        status: (instances.get(instanceId) as any)?.status ?? "running",
        role: (instances.get(instanceId) as any)?.roleName ?? "unknown",
      }));
    },
    getState: (instanceId) => {
      for (const [, handle] of rc.getRegisteredAgents()) {
        const instances = typeof (handle as any)?.getInstances === "function"
          ? (handle as any).getInstances()
          : undefined;
        const instance = instances?.get(instanceId);
        if (instance) {
          return {
            currentState: typeof instance.getCurrentStateId === "function" ? instance.getCurrentStateId() : "unknown",
            status: instance.getStatus?.() ?? instance.status ?? "running",
            ctx: instance.ctx ?? {},
          };
        }
      }
      return null;
    },
  });

  await mcpServer.startStdio();
  log("MCP stdio server running");

  // ── Graceful shutdown ──

  const shutdown = async () => {
    await mcpServer.close();
    for (const link of createdLinks.values()) {
      await link.close();
    }
    await controlEndpoint.stop();
    await rc.stop();
    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[mcp-gate] Fatal: ${err}\n`);
  process.exit(1);
});
