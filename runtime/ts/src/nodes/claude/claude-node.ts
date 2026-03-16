#!/usr/bin/env node
/**
 * Config-driven Claude node for Reagent protocols.
 *
 * Bootstraps a ReagentController directly in-process and registers
 * a ClaudeBehaviorFactory that calls the Claude API via handle().
 * No MCP child process — the agent runs in the same OS process as the RC.
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required
 *   CLAUDE_NODE_CONFIG  — path to Claude live-agent node wrapper config
 *
 * Legacy fallback environment:
 *   MCP_RUNTIME_CONFIG, AGENT_NAME, AGENT_ROLES, MAX_TURNS,
 *   EVENT_WAIT_TIMEOUT_MS, AGENT_EXTRA_INSTRUCTIONS
 */

import { readFileSync } from "node:fs";
import { ReagentController } from "../../controller/reagent-controller.js";
import { NatsNodeLink } from "../../network/nats-node-link.js";
import { EtcdStateStore } from "../../cluster/etcd-state-store.js";
import { InMemoryStateStore } from "../../cluster/state-store.js";
import { NodeControlEndpoint } from "../../admin/node-control-endpoint.js";
import { DebugAdvanceHook } from "../../admin/debug-advance-hook.js";
import { createDefaultRuntimeConfig } from "../../cluster/runtime-config.js";
import { bootstrapRuntime } from "../../cluster/runtime-bootstrap.js";
import { mergeRoleBindings } from "../../controller/role-bindings.js";
import type { RuntimeConfig } from "../../cluster/runtime-config.js";
import type { RoleIR, IRGraph } from "../../contracts/types.js";
import type { RoleBindingMap, LegacyRoleBindingMap } from "../../controller/role-bindings.js";
import type { Lease } from "../../cluster/state-store.js";
import { ClaudeBehaviorFactory } from "./claude-behavior-factory.js";
import type { AgentBehavior } from "../../contracts/agent-behavior.js";
import type { BehaviorFactory } from "../../contracts/behavior-factory.js";
import type { ProtocolEvent, AgentResponse } from "../../core/protocol-engine.js";
import {
  loadClaudeLiveAgentNodeConfig,
  resolveClaudeCwd,
  type ClaudePermissionMode,
  type ClaudeToolsConfig,
  type ClaudeMcpServersConfig,
} from "./claude-config.js";

// ── Config resolution ────────────────────────────────────────────────

const nodeConfigPath = process.env.CLAUDE_NODE_CONFIG;
const runtimeConfigPath = process.env.MCP_RUNTIME_CONFIG;
const agentName = process.env.AGENT_NAME ?? process.env.WORKER_AGENT ?? "WorkerAgent";
const roles = (process.env.AGENT_ROLES ?? process.env.WORKER_ROLES ?? "WorkerRole")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const maxTurns = parseInt(process.env.MAX_TURNS ?? "4", 10);
const extraInstructions = process.env.AGENT_EXTRA_INSTRUCTIONS?.trim() ?? "";

let activeAgentName = agentName;

function log(message: string): void {
  process.stderr.write(`[claude-node ${activeAgentName}] ${message}\n`);
}

function emitJson(kind: string, payload: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      agentName: payload.agentName ?? activeAgentName,
      kind,
      ...payload,
    })}\n`,
  );
}

const lastCtxByAgent = new Map<string, Record<string, unknown>>();

class ObservableBehavior implements AgentBehavior {
  constructor(
    private inner: AgentBehavior,
    private agentName: string,
  ) {}

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    const response = await this.inner.handle(event);
    const ctx = response.type === "ctx_update" ? (response as { ctx?: Record<string, unknown> }).ctx : undefined;
    if (ctx) {
      lastCtxByAgent.set(this.agentName, ctx);
    }
    emitJson("response", {
      agentName: this.agentName,
      protocolName: "protocolName" in event ? event.protocolName : undefined,
      eventType: event.type,
      stateId: "stateId" in event ? event.stateId : undefined,
      ctx,
      response,
    });
    return response;
  }
}

class ObservableBehaviorFactory implements BehaviorFactory {
  readonly runtimeName: string;

  constructor(private inner: BehaviorFactory) {
    this.runtimeName = inner.runtimeName;
  }

  createBehavior(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): AgentBehavior {
    const behavior = this.inner.createBehavior(agentName, roleIR, graphs, extras);
    return new ObservableBehavior(behavior, agentName);
  }

  async destroyBehavior(behavior: AgentBehavior): Promise<void> {
    await this.inner.destroyBehavior?.(behavior);
  }
}

interface ResolvedConfig {
  agentName: string;
  roles: string[];
  runtimeConfig: RuntimeConfig;
  maxTurns: number;
  extraInstructions: string;
  permissionMode: ClaudePermissionMode;
  tools: ClaudeToolsConfig;
  mcpServers?: ClaudeMcpServersConfig;
  model?: string;
  cwd?: string;
}

function loadRuntimeConfig(path: string): RuntimeConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  if (!raw || typeof raw !== "object") throw new Error(`Invalid runtime config at ${path}`);
  return raw;
}

function resolveConfig(): ResolvedConfig {
  if (nodeConfigPath) {
    const loaded = loadClaudeLiveAgentNodeConfig(nodeConfigPath);
    const fileConfig = loaded.config.runtime as unknown as RuntimeConfig;
    const nodeId = fileConfig.nodeId ?? `claude-${loaded.config.agent.name}-${process.pid}`;
    const baseConfig = createDefaultRuntimeConfig(nodeId);

    return {
      agentName: loaded.config.agent.name,
      roles: loaded.config.agent.roles,
      runtimeConfig: {
        ...baseConfig,
        ...fileConfig,
        nodeId,
        langs: fileConfig.langs ?? baseConfig.langs,
        stateStore: fileConfig.stateStore ?? baseConfig.stateStore,
        messagePlane: fileConfig.messagePlane ?? baseConfig.messagePlane,
        membership: fileConfig.membership ?? baseConfig.membership,
        telemetry: fileConfig.telemetry ?? baseConfig.telemetry,
        controlEndpoint: fileConfig.controlEndpoint ?? { enabled: true, host: "127.0.0.1", port: 0 },
        triggerPolicies: fileConfig.triggerPolicies ?? baseConfig.triggerPolicies,
        cronIntervalMs: fileConfig.cronIntervalMs ?? baseConfig.cronIntervalMs,
      },
      maxTurns: loaded.config.claude?.maxTurns ?? maxTurns,
      extraInstructions: loaded.config.claude?.extraInstructions?.trim() ?? extraInstructions,
      permissionMode: loaded.config.claude?.permissionMode ?? "bypassPermissions",
      tools: loaded.config.claude?.tools ?? [],
      mcpServers: loaded.config.claude?.mcpServers,
      model: loaded.config.claude?.model,
      cwd: resolveClaudeCwd(loaded.configDir, loaded.config.claude),
    };
  }

  if (runtimeConfigPath) {
    const fileConfig = loadRuntimeConfig(runtimeConfigPath);
    const nodeId = fileConfig.nodeId ?? `claude-${agentName}-${process.pid}`;
    const baseConfig = createDefaultRuntimeConfig(nodeId);

    return {
      agentName,
      roles,
      runtimeConfig: {
        ...baseConfig,
        ...fileConfig,
        nodeId,
      },
      maxTurns,
      extraInstructions,
      permissionMode: "bypassPermissions",
      tools: [],
    };
  }

  throw new Error("CLAUDE_NODE_CONFIG or MCP_RUNTIME_CONFIG is required");
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  const resolved = resolveConfig();
  activeAgentName = resolved.agentName;
  const { runtimeConfig } = resolved;
  const nodeId = runtimeConfig.nodeId;
  const langs = runtimeConfig.langs ?? ["ts"];
  const startedAt = new Date().toISOString();

  log(`Bootstrapping RC in-process (node: ${nodeId})`);

  // ── Behavior factory ──

  const claudeFactory = new ClaudeBehaviorFactory(resolved.roles, {
    model: resolved.model,
    maxTurns: resolved.maxTurns,
    extraInstructions: resolved.extraInstructions,
    permissionMode: resolved.permissionMode,
    tools: resolved.tools,
    mcpServers: resolved.mcpServers,
    cwd: resolved.cwd,
  });

  const observableFactory = new ObservableBehaviorFactory(claudeFactory);

  const behaviorFactories: Record<string, BehaviorFactory> = {};
  for (const lang of langs) behaviorFactories[lang] = observableFactory;

  // ── RC setup ──

  const roleToAgent: RoleBindingMap = {};
  const natsUrl = runtimeConfig.messagePlane?.kind === "nats" ? runtimeConfig.messagePlane.url : undefined;
  const stateStore = runtimeConfig.stateStore.kind === "etcd"
    ? new EtcdStateStore({ hosts: runtimeConfig.stateStore.hosts })
    : new InMemoryStateStore();

  const rc = new ReagentController({
    nodeId,
    behaviorFactories,
    stateStore,
    triggerPolicies: runtimeConfig.triggerPolicies,
  });

  // ── Cluster bootstrap with lazy NatsNodeLink ──

  const createdLinks = new Map<string, NatsNodeLink>();

  const ensureLink = async (remoteNodeId: string): Promise<void> => {
    if (createdLinks.has(remoteNodeId)) return;
    if (!natsUrl) throw new Error("NATS node links require messagePlane.kind = \"nats\"");
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
        if (!natsUrl) throw new Error("remote agent discovery requires messagePlane.kind = \"nats\"");
        await ensureLink(remoteNodeId);
        rc.registerRemoteAgent(agentName, remoteNodeId);
        log(`Discovered remote agent: ${agentName} on ${remoteNodeId}`);
      } catch (err) {
        log(`Failed to set up link for ${remoteNodeId}: ${err}`);
      }
    },
    onRemoteAgentRemoved: (agentName) => log(`Remote agent removed: ${agentName}`),
    onNodeJoin: (nid) => log(`Node joined: ${nid}`),
    onNodeLeave: async (nid) => {
      log(`Node left: ${nid}`);
      const link = createdLinks.get(nid);
      if (link) {
        await link.close();
        createdLinks.delete(nid);
      }
    },
  });

  if (runtime.membership) {
    rc.setAgentPresenceLease(runtime.membership.getLeaseId());
  }
  log(`State store: ${runtimeConfig.stateStore.kind}`);

  // ── Node control endpoint ──

  const debugHooks = new Map<string, DebugAdvanceHook>();
  const debugState = new Map<string, Record<string, unknown>>();

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
        case "ListProtocolRuns":
          return await handleListProtocolRuns();
        case "InspectProtocolRun":
          return await handleInspectProtocolRun(payload);
        case "CancelProtocolRun":
          return await handleCancelProtocolRun(payload);
        case "StoreGet": {
          const key = payload.key as string;
          const val = await runtime.stateStore.get(key);
          return { value: val == null ? null : typeof val === "string" ? val : val.toString("utf8") };
        }
        case "StoreList": {
          const prefix = (payload.prefix as string) ?? "/";
          const entries = await runtime.stateStore.list(prefix);
          return {
            entries: entries.map((e) => ({
              key: e.key,
              value: (e.value == null ? "" : typeof e.value === "string" ? e.value : e.value.toString("utf8")),
            })),
          };
        }
        case "GetProjectedState":
          return { nodeId, inspect: rc.inspect() };
        default:
          throw new Error(`Unsupported node control op: ${op}`);
      }
    },
  });

  const boundControlPort = await controlEndpoint.start();
  const advertisedControlUrl = runtimeConfig.controlEndpoint?.advertiseUrl
    ?? `ws://${runtimeConfig.controlEndpoint?.host ?? "127.0.0.1"}:${boundControlPort}`;

  let standaloneLease: Lease | null = null;
  let standaloneLeaseKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  if (runtime.membership) {
    await runtime.membership.updateNodeMetadata({
      control: { kind: "ws", url: advertisedControlUrl },
      capabilities: { deploy: true, inspect: true, trigger: true, stateStoreProxy: true },
      metadata: { langs },
    });
  } else {
    const leaseTtlSeconds = runtimeConfig.membership?.leaseTtlSeconds ?? 15;
    const keepAliveIntervalMs = Math.floor((leaseTtlSeconds * 1000) / 3);
    standaloneLease = await runtime.stateStore.createLease(leaseTtlSeconds);
    standaloneLeaseKeepAliveTimer = setInterval(() => {
      standaloneLease?.keepAlive().catch((err: unknown) => log(`Standalone lease keepAlive failed: ${String(err)}`));
    }, keepAliveIntervalMs);
    rc.setAgentPresenceLease(standaloneLease.id);
    await runtime.stateStore.put(`/nodes/${nodeId}`, JSON.stringify({
      nodeId, startedAt,
      control: { kind: "ws", url: advertisedControlUrl },
      capabilities: { deploy: true, inspect: true, trigger: true, stateStoreProxy: true },
      metadata: { langs },
    }), { lease: standaloneLease.id });
  }

  log(`Node control endpoint at ${advertisedControlUrl}`);

  emitJson("started", {
    agentName: resolved.agentName,
    roles: resolved.roles,
    nodeId,
    controlUrl: advertisedControlUrl,
  });

  // The agent is now running. Deploy and trigger operations arrive via the
  // control endpoint. The ClaudeBehavior handles protocol events directly
  // inside handle() — no polling loop needed.

  // ── Graceful shutdown ──

  const shutdown = async () => {
    for (const link of createdLinks.values()) await link.close();
    if (standaloneLeaseKeepAliveTimer) {
      clearInterval(standaloneLeaseKeepAliveTimer);
      standaloneLeaseKeepAliveTimer = null;
    }
    if (standaloneLease) {
      try { await standaloneLease.revoke(); } catch { /* best effort */ }
      standaloneLease = null;
    }
    await controlEndpoint.stop();
    await rc.stop();
    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Control endpoint handlers ──

  function buildNodeInspect(): Record<string, unknown> {
    const agents = [...rc.getAgentRecords()].map(([name, record]) => ({
      name,
      lang: record.runtime?.runtimeName ?? "claude",
      route: record.runtime?.nodeId ? `local (${record.runtime.nodeId})` : `declared (${nodeId})`,
    }));
    const protocols: Array<{ name: string; version: string; agents: string[]; graphs: string[] }> = [];
    const seenProtos = new Set<string>();
    for (const [an, handle] of rc.getRegisteredAgents()) {
      const graphs = (handle as any).graphs as Map<string, unknown> | undefined;
      if (graphs) {
        for (const key of graphs.keys()) {
          const protoName = key.split(".")[0];
          if (!seenProtos.has(protoName)) {
            seenProtos.add(protoName);
            protocols.push({ name: protoName, version: "1.0", agents: [an], graphs: [key] });
          }
        }
      }
    }
    return {
      nodeId,
      agents,
      protocols,
      protocolRuns: rc.inspect().protocolRuns,
      routing: Object.fromEntries(
        Object.entries(roleToAgent).map(([k, v]) => [k, v.agents.join(",")]),
      ),
      agentNodes: [nodeId],
      projectedState: { routing: rc.inspect().routing },
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

    if (!deployment) throw new Error("Missing deployment payload");

    const deployedAgents: string[] = [];
    for (const agentDef of deployment.agents) {
      if (!langs.includes(agentDef.lang)) continue;
      const roleIR = (roleIRs[agentDef.roleName] ?? roleIRs[`${agentDef.roleName}.role`]) as RoleIR | undefined;
      if (!roleIR) continue;

      const graphs = new Map<string, IRGraph>();
      for (const binding of agentDef.roles) {
        const key = `${binding.protocolName}.${binding.roleName}`;
        if (irGraphs[key]) graphs.set(key, irGraphs[key] as IRGraph);
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
      rc.createAgentFromTemplate(agentDef.agentName);

      const shell = rc.getAgent(agentDef.agentName);
      if (shell) {
        shell.onRunCompleted((run, status) => {
          emitJson("lifecycle", {
            agentName: agentDef.agentName,
            instanceId: run.instanceId,
            protocolName: run.protocolName,
            role: run.roleName,
            eventType: status === "completed" ? "protocol_completed" : status === "failed" ? "protocol_failed" : "protocol_cancelled",
            ctx: lastCtxByAgent.get(agentDef.agentName),
          });
        });
      }

      deployedAgents.push(agentDef.agentName);
      log(`Deployed agent: ${agentDef.agentName}`);
    }
    return { nodeId, deployedAgents };
  }

  function handleTrigger(payload: Record<string, unknown>): Record<string, unknown> {
    const triggerAgent = payload.agentName as string;
    const protocolName = payload.protocolName as string;
    const instanceId = (payload.instanceId as string | undefined) ?? `${protocolName}-${Date.now()}`;
    const input = (payload.input as Record<string, unknown>) ?? {};
    const rta = mergeRoleBindings(protocolName, {}, (payload.roleToAgent as LegacyRoleBindingMap) ?? roleToAgent);
    const mode = payload.mode as string | undefined;
    const sessionId = payload.sessionId as string | undefined;

    if (mode === "debug" && sessionId) {
      installDebugHook(sessionId, (payload.breakpoints as string[]) ?? []);
    }
    rc.triggerProtocol(triggerAgent, { instanceId, protocolName, input, roleToAgent: rta });
    log(`Triggered: ${protocolName} instance=${instanceId} agent=${triggerAgent}`);
    return { nodeId, agentName: triggerAgent, protocolName, instanceId };
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
        sessionId, level: "state",
        agentName: event.agentName, stateId: event.stateId,
        stateKind: event.stateKind, instanceId: event.instanceId,
        protocolName: event.protocolName, roleName: event.roleName,
        ctx: event.ctx, self: event.self, reason: event.reason,
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
      case "continue": hook.continue(); break;
      case "stepState": case "stepIntoScatter": case "stepIntoInvoke": hook.stepState(); break;
      case "stepOver": case "stepOverScatter": case "stepOverInvoke": hook.stepOver(); break;
      case "stepOutScatter": case "stepOutInvoke": hook.continue(); break;
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
    return { sessionId, breakpoints };
  }

  function handleGetState(payload: Record<string, unknown>): Record<string, unknown> {
    return debugState.get(payload.sessionId as string) ?? { sessionId: payload.sessionId };
  }

  function handleStopAgent(payload: Record<string, unknown>): Record<string, unknown> {
    rc.detachAgentRuntime(payload.agentName as string);
    return { nodeId, agentName: payload.agentName, stopped: true };
  }

  function handleGetDeployedIR(payload: Record<string, unknown>): Record<string, unknown> {
    const pn = payload.protocolName as string | undefined;
    if (!pn) {
      return { nodeId, protocols: rc.listProtocols().map((e) => ({ name: e.name, version: e.version })) };
    }
    const matching = rc.listProtocols().find((e) => e.name === pn);
    return { nodeId, protocolName: pn, irGraphs: matching ? Object.fromEntries([...matching.irGraphs.entries()]) : {} };
  }

  async function handleListProtocolRuns(): Promise<Record<string, unknown>> {
    const runs = await rc.listProtocolRuns();
    return { nodeId, runs, total: runs.length };
  }

  async function handleInspectProtocolRun(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const instanceId = payload.instanceId as string;
    const inspected = await rc.inspectProtocolRun(instanceId);
    return { nodeId, instanceId, found: !!inspected.record, ...inspected };
  }

  async function handleCancelProtocolRun(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const instanceId = payload.instanceId as string;
    const cancelled = await rc.cancelProtocolRun(instanceId);
    return { nodeId, instanceId, cancelled };
  }
}

main().catch((err) => {
  process.stderr.write(
    `[claude-node] Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
