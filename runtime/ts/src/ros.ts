/**
 * ReagentOrchestratorServer (ROS) — WebSocket service for compile/deploy/run/debug.
 *
 * Accepts RAP protocol messages as JSON text frames:
 *   { rap: "CompileRequest", id: "req-1", payload: { rgSource, fileName } }
 *
 * The compiler and runtime have separate type systems (by design — no rootDir sharing).
 * At the boundary we use JSON serialization or `as unknown as` casts.
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

import { ReagentController } from "./reagent-controller.js";
import { NativeAgentNode } from "./native-agent-node.js";
import { SessionManager, Session } from "./session.js";
import type { SourceMap, SourceMapEntry } from "./session.js";
import type { IRGraph, RoleIR, TraceEvent } from "./types.js";
import type { TraceHook } from "./interceptor.js";
import { DebugController, type Breakpoint } from "./debug-controller.js";
import type { AdvanceHook } from "./protocol-instance.js";
import { reconcile, planSummary, type ReconciliationPlan } from "./reconciler.js";
import type { DeploySpec } from "./deploy-spec.js";
import { createEmptyView, mergeNodeProtocols, type RegistryView } from "./registry-view.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lazy-loaded compiler functions (avoids import issues with separate type systems)
let _compiler: {
  parseProgram: (src: string) => any;
  emitIR: (proto: any) => any;
  emitRoleIR: (role: any, roleMap: any) => any;
  emitAgentIR: (agent: any, roleMap: any) => any;
  emitMessageSchema: (msg: any) => any;
  resetIdCounter: () => void;
  validateIRGraph: (graph: any) => any;
} | null = null;

async function getCompiler() {
  if (_compiler) return _compiler;
  const parser = await import("../../../lang/dist/parser.js");
  const emitter = await import("../../../lang/dist/ir-emitter.js");
  const validator = await import("../../../lang/dist/ir-validator.js");
  _compiler = {
    parseProgram: parser.parseProgram,
    emitIR: emitter.emitIR,
    emitRoleIR: emitter.emitRoleIR,
    emitAgentIR: emitter.emitAgentIR,
    emitMessageSchema: emitter.emitMessageSchema,
    resetIdCounter: emitter.resetIdCounter,
    validateIRGraph: validator.validateIRGraph,
  };
  return _compiler;
}

export interface ROSConfig {
  port: number;
}

interface RAPMessage {
  rap: string;
  id?: string;
  payload?: Record<string, unknown>;
}

interface AdapterInfo {
  nodeId: string;
  ws: WebSocket;
  supportedLangs: string[];
  deployedAgents: string[];
  requestedAgents: string[];
}

export class ReagentOrchestratorServer {
  private wss: WebSocketServer | null = null;
  private sessions: SessionManager;
  private config: ROSConfig;
  private clients = new Set<WebSocket>();
  private debugController: DebugController;
  private adapters = new Map<string, AdapterInfo>();
  private clusterDebugSessions = new Set<string>();
  private _deployGeneration = 0;
  /** Internal RC for system protocols (self-hosting). */
  private systemRC: ReagentController | null = null;

  /** Instance tree for DAP thread display: tracks parent/child relationships between protocol instances. */
  private instanceTree = new Map<string, { parentId?: string; childIds: Set<string>; protocolName: string; agentName: string }>();

  constructor(config: ROSConfig) {
    this.config = config;
    this.sessions = new SessionManager();
    this.debugController = new DebugController();
    this.debugController.setOnStopped((event) => {
      const msg = JSON.stringify({
        rap: "Stopped",
        payload: event,
      });
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    });
  }

  /** Bootstrap the internal system RC for self-hosting. */
  private initSystemRC(): void {
    try {
      const agentNode = new NativeAgentNode({ roleToAgent: {} });
      this.systemRC = new ReagentController({
        nodeId: "ros-system",
        agentNode,
      });
      console.log("[ROS] System RC initialized (self-hosting bootstrap)");
    } catch {
      console.warn("[ROS] System RC initialization deferred — no system protocols loaded yet");
    }
  }

  getSystemRC(): ReagentController | null {
    return this.systemRC;
  }

  /** Returns session IDs for all active debug sessions (local + cluster). */
  private activeDebugSessions(): string[] {
    return [
      ...this.sessions.getActiveSessionIds(),
      ...this.clusterDebugSessions,
    ];
  }

  async start(): Promise<number> {
    this.initSystemRC();

    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.config.port }, () => {
        const addr = this.wss!.address();
        const port = typeof addr === "object" && addr ? addr.port : this.config.port;
        resolve(port);
      });

      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("message", (data) => {
          this.handleMessage(ws, data.toString());
        });
        ws.on("close", () => {
          this.clients.delete(ws);
        });
      });
    });
  }

  async stop(): Promise<void> {
    if (this.systemRC) {
      await this.systemRC.stop();
      this.systemRC = null;
    }
    for (const session of this.sessions.all()) {
      await this.sessions.destroy(session.sessionId);
    }
    if (this.wss) {
      return new Promise((resolve) => this.wss!.close(() => resolve()));
    }
  }

  getSessionManager(): SessionManager {
    return this.sessions;
  }

  private sendRap(ws: WebSocket, rap: string, id: string | undefined, payload: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    console.log(`[ROS] → ${rap} id=${id ?? '-'}`);
    ws.send(JSON.stringify({ rap, id, payload }));
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: RAPMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle bare envelope relay (cross-node routing from adapter nodes)
    if (!msg.rap && (msg as any).from && (msg as any).to) {
      const envelope = msg as unknown as Record<string, unknown>;
      const target = (envelope.to as Record<string, string>)?.agent;
      if (target) {
        const nodeId = this.agentToNode.get(target);
        if (nodeId) {
          const adapter = this.adapters.get(nodeId);
          if (adapter && adapter.ws.readyState === WebSocket.OPEN) {
            adapter.ws.send(raw);
          }
        }
      }
      return;
    }

    console.log(`[ROS] ← ${msg.rap} id=${msg.id ?? '-'}`);

    switch (msg.rap) {
      case "Compile":
        this.handleCompile(ws, msg).catch(e => console.error(`[ROS] Compile error:`, e));
        break;
      case "RunStart":
        this.handleRunStart(ws, msg);
        break;
      case "SetBreakpointsRequest":
        this.handleSetBreakpoints(ws, msg);
        break;
      case "DebugCommand":
        this.handleDebugCommand(ws, msg);
        break;
      case "GetState":
        this.handleGetState(ws, msg);
        break;
      case "Register":
        this.handleAdapterRegister(ws, msg);
        break;
      case "Deployed":
        this.handleAdapterDeployed(ws, msg);
        break;
      case "TraceEvent":
        this.handleAdapterTrace(ws, msg);
        break;
      case "ListProtocols":
        this.handleListProtocols(ws, msg);
        break;
      case "DeployProtocol":
        this.handleDeployProtocol(ws, msg);
        break;
      case "ClusterStatus":
        this.handleClusterStatus(ws, msg);
        break;
      case "SubmitDeploySpec":
        this.handleSubmitDeploySpec(ws, msg);
        break;
      case "StopAgent":
        this.handleStopAgent(ws, msg);
        break;
      case "DeployProject":
        this.handleDeployProject(ws, msg).catch(e => console.error(`[ROS] DeployProject error:`, e));
        break;
      case "TriggerOnCluster":
        this.handleTriggerOnCluster(ws, msg);
        break;
      case "RouteEnvelope":
        this.handleRouteEnvelope(ws, msg);
        break;
      case "NodeInspect":
        this.handleNodeInspect(ws, msg);
        break;
      case "NodeInspectResult":
        this.handleNodeInspectResult(ws, msg);
        break;
      case "DebugStopped":
        this.handleDebugStopped(ws, msg);
        break;
      case "GetDeployedIR":
        this.handleGetDeployedIR(ws, msg);
        break;
      case "ListAgents":
        this.handleListAgents(ws, msg);
        break;
      default:
        break;
    }
  }

  // ── Compile ──────────────────────────────────────────────────────

  private async handleCompile(ws: WebSocket, msg: RAPMessage): Promise<void> {
    const payload = msg.payload ?? {};
    const rgSource = payload.rgSource as string;
    const fileName = (payload.fileName as string) ?? "input.rg";

    try {
      const result = await this.compileSource(rgSource, fileName);
      const session = this.sessions.create(rgSource, fileName);
      session.compiled = result;

      const irGraphsObj: Record<string, any> = {};
      for (const [k, v] of result.irGraphs) irGraphsObj[k] = v;
      const roleIRsObj: Record<string, any> = {};
      for (const [k, v] of result.roleIRs) roleIRsObj[k] = v;

      this.sendRap(ws, "CompileSuccess", msg.id, {
        sessionId: session.sessionId,
        irGraphs: irGraphsObj,
        roleIRs: roleIRsObj,
        deployment: result.deployment,
        sourceMap: result.sourceMap,
      });
    } catch (err) {
      this.sendRap(ws, "CompileError", msg.id, {
        errors: [{ line: 0, column: 0, message: String(err) }],
      });
    }
  }

  private async compileSource(rgSource: string, fileName: string) {
    const compiler = await getCompiler();
    const parseResult = compiler.parseProgram(rgSource);
    if (!parseResult.ok) {
      const errs = parseResult.errors.map((e: any) => ({
        line: e.loc.start.line,
        column: e.loc.start.col,
        message: e.message,
      }));
      throw new Error(`Parse errors: ${JSON.stringify(errs)}`);
    }

    const items = parseResult.ast.items;
    const protocols = items.filter((i: any) => i.kind === "ProtocolDef");
    const agents = items.filter((i: any) => i.kind === "AgentDef");
    const roles = items.filter((i: any) => i.kind === "RoleDef");

    const roleMap = new Map<string, any>();
    for (const r of roles) roleMap.set(r.name, r);

    const irGraphs = new Map<string, IRGraph>();
    const roleIRs = new Map<string, RoleIR>();
    const sourceMapEntries: SourceMapEntry[] = [];

    for (const proto of protocols) {
      compiler.resetIdCounter();
      const result = compiler.emitIR(proto);
      if (!result.ok) throw new Error(`IR emit errors: ${result.errors.join(", ")}`);
      for (const [role, graph] of result.graphs) {
        const key = `${proto.name}.${role}`;
        const graphObj = JSON.parse(JSON.stringify(graph)) as IRGraph;
        irGraphs.set(key, graphObj);
      }
      // Collect source map entries from the compiler, fill in file name
      for (const entry of (result.sourceMap ?? [])) {
        sourceMapEntries.push({
          stateId: entry.stateId,
          protocolName: entry.protocolName,
          role: entry.role,
          file: entry.file || fileName,
          line: entry.line,
          column: entry.column,
        });
      }
    }

    for (const role of roles) {
      const result = compiler.emitRoleIR(role, roleMap);
      if (!result.ok) throw new Error(`Role IR errors: ${result.errors.join(", ")}`);
      const roleIR = JSON.parse(JSON.stringify(result.roleIR)) as RoleIR;
      roleIRs.set(role.name, roleIR);
    }

    const roleToAgent: Record<string, string> = {};
    const deploymentAgents: Array<Record<string, any>> = [];

    for (const agent of agents) {
      const agentResult = compiler.emitAgentIR(agent, roleMap);
      if (!agentResult.ok) throw new Error(`Agent IR errors: ${agentResult.errors.join(", ")}`);

      const roleName = agent.runs;
      const roleResult = roleMap.has(roleName)
        ? compiler.emitRoleIR(roleMap.get(roleName)!, roleMap)
        : undefined;
      const plays = roleResult?.roleIR.plays ?? [];

      const da: Record<string, any> = {
        agentName: agent.name,
        lang: agentResult.agentIR.lang,
        roleName,
        roles: plays.map((p: any) => ({
          protocolName: p.protocolName,
          roleName: p.roleName,
        })),
      };

      for (const p of plays) {
        roleToAgent[`${p.protocolName}.${p.roleName}`] = agent.name;
      }
      deploymentAgents.push(da);
    }

    const deployment = { agents: deploymentAgents, roleToAgent };
    const sourceMap: SourceMap = { entries: sourceMapEntries };

    return { irGraphs, roleIRs, deployment, sourceMap };
  }

  // ── Run ──────────────────────────────────────────────────────────

  private async handleRunStart(ws: WebSocket, msg: RAPMessage): Promise<void> {
    const payload = msg.payload ?? {};
    const sessionId = payload.sessionId as string;
    const mode = (payload.mode as string) ?? "run";

    const session = this.sessions.get(sessionId);
    if (!session || !session.compiled) {
      this.sendRap(ws, "RunFailed", msg.id, { error: "Session not found or not compiled" });
      return;
    }

    try {
      await this.runSession(ws, session, msg.id, mode);
    } catch (err) {
      this.sendRap(ws, "RunFailed", msg.id, { error: String(err) });
    }
  }

  private async runSession(ws: WebSocket, session: Session, requestId: string | undefined, mode: string): Promise<void> {
    const compiled = session.compiled!;
    const deployment = compiled.deployment as {
      agents: Array<{ agentName: string; lang: string; roleName: string; roles: Array<{ protocolName: string; roleName: string }> }>;
      roleToAgent: Record<string, string>;
    };

    const isDebugMode = mode === "debug";
    let debugAdvanceHook: AdvanceHook | undefined;
    const interceptors: any[] = [];

    let debugResolveHook: ((data: { role: string; candidates: string[]; selected: string[]; pipelineSummary: string; triggerId?: string; instanceId?: string }) => Promise<void>) | undefined;

    if (isDebugMode) {
      const debugInstruments = this.debugController.createSession(
        session.sessionId,
        compiled.sourceMap,
      );
      debugAdvanceHook = debugInstruments.advanceHook;
      debugResolveHook = debugInstruments.resolveHook;
      interceptors.push(debugInstruments.interceptorFn);
    }

    const traceHook: TraceHook = (event: TraceEvent) => {
      session.pushTrace(event);
      this.sendRap(ws, "TraceEvent", undefined, event as unknown as Record<string, unknown>);
      this.updateInstanceTree(event);
    };

    const roleToAgent = deployment.roleToAgent;
    const tsNode = new NativeAgentNode({
      roleToAgent,
      traceHook,
      advanceHook: debugAdvanceHook,
    });

    const rc = new ReagentController({
      nodeId: `ros-${session.sessionId.slice(0, 8)}`,
      agentNodes: { ts: tsNode, "*": tsNode },
      interceptors,
      debugResolveHook,
    });
    session.rc = rc;
    session.setStatus("running");

    for (const agentDef of deployment.agents) {
      const roleName = agentDef.roleName;
      const roleIR = compiled.roleIRs.get(roleName);
      if (!roleIR) throw new Error(`Role IR not found for ${roleName}`);

      const agentGraphs = new Map<string, IRGraph>();
      for (const binding of agentDef.roles) {
        const key = `${binding.protocolName}.${binding.roleName}`;
        const graph = compiled.irGraphs.get(key);
        if (graph) agentGraphs.set(key, graph);
      }

      rc.registerAgent(agentDef.agentName, roleIR, agentGraphs);
    }

    await rc.start();

    // Set up completion monitoring
    const completionPromise = new Promise<void>((resolve) => {
      session.setOnStatusChange((s) => {
        if (s.status === "completed" || s.status === "failed") {
          resolve();
        }
      });
    });

    // Trigger the first protocol across all participating agents
    const firstAgent = deployment.agents[0];
    if (firstAgent) {
      const firstRole = firstAgent.roles[0];
      if (firstRole) {
        const instanceId = randomUUID();
        for (const agentDef of deployment.agents) {
          for (const binding of agentDef.roles) {
            if (binding.protocolName === firstRole.protocolName) {
              rc.triggerProtocol(agentDef.agentName, {
                instanceId,
                protocolName: binding.protocolName,
                input: {},
                roleToAgent,
              });
            }
          }
        }
      }
    }

    // Poll for completion
    const poll = setInterval(() => {
      let allDone = true;
      for (const agentDef of deployment.agents) {
        const handle = rc.getAgent(agentDef.agentName) as any;
        if (handle?.getInstances) {
          const instances = handle.getInstances() as Map<string, { getStatus: () => string }>;
          for (const [, inst] of instances) {
            const status = inst.getStatus();
            if (status !== "completed" && status !== "failed") {
              allDone = false;
            }
          }
        } else if (handle?.getRunner) {
          const runner = handle.getRunner();
          const instances = runner.getInstances?.() as Map<string, { getStatus: () => string }> | undefined;
          if (instances) {
            for (const [, inst] of instances) {
              const status = inst.getStatus();
              if (status !== "completed" && status !== "failed") {
                allDone = false;
              }
            }
          }
        }
      }
      if (allDone && session.status === "running") {
        session.setStatus("completed");
      }
    }, 50);

    // Wait for completion; in debug mode, no timeout (user controls execution)
    if (isDebugMode) {
      await completionPromise;
    } else {
      await Promise.race([
        completionPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 30000)),
      ]);
    }

    clearInterval(poll);

    if (session.status === "running") {
      session.setStatus("completed");
    }

    const agentStates: Record<string, unknown> = {};
    for (const agentDef of deployment.agents) {
      const handle = rc.getAgent(agentDef.agentName);
      if (handle) agentStates[agentDef.agentName] = handle.getSelf();
    }

    this.sendRap(ws, "RunCompleted", requestId, {
      sessionId: session.sessionId,
      status: session.status,
      agentStates,
    });
  }

  // ── Instance tree tracking ────────────────────────────────────────

  private updateInstanceTree(event: TraceEvent): void {
    switch (event.kind) {
      case "ProtocolStarted": {
        const existing = this.instanceTree.get(event.instanceId);
        if (!existing) {
          this.instanceTree.set(event.instanceId, {
            childIds: new Set(),
            protocolName: event.protocolName ?? event.data?.protocolName as string ?? "unknown",
            agentName: event.agent,
          });
        }
        break;
      }
      case "SpawnStarted": {
        const parentInstanceId = event.data?.parentInstanceId as string | undefined;
        if (parentInstanceId) {
          const parentEntry = this.instanceTree.get(parentInstanceId);
          if (parentEntry) {
            parentEntry.childIds.add(event.instanceId);
          }
          const childEntry = this.instanceTree.get(event.instanceId);
          if (childEntry) {
            childEntry.parentId = parentInstanceId;
          } else {
            this.instanceTree.set(event.instanceId, {
              parentId: parentInstanceId,
              childIds: new Set(),
              protocolName: event.protocolName ?? "unknown",
              agentName: event.agent,
            });
          }
        }
        break;
      }
      case "ProtocolCompleted":
      case "ProtocolFailed":
        // Entry stays in the tree for DAP display; no removal needed.
        break;
    }
  }

  getInstanceTree(instanceId: string): { parentId?: string; children: string[] } | undefined {
    const entry = this.instanceTree.get(instanceId);
    if (!entry) return undefined;
    return { parentId: entry.parentId, children: [...entry.childIds] };
  }

  // ── Debug handlers ────────────────────────────────────────────────

  private handleSetBreakpoints(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const sessionId = payload.sessionId as string;

    // Accept both the spec format (separate arrays) and the legacy format (breakpoints[])
    let breakpoints: Breakpoint[];
    if (Array.isArray(payload.breakpoints)) {
      breakpoints = payload.breakpoints as Breakpoint[];
    } else {
      breakpoints = [];
      const msgBps = (payload.messageBreakpoints as string[]) ?? [];
      const srcLocs = (payload.sourceLocations as Array<{ file: string; line: number }>) ?? [];
      const kindBps = (payload.stateKindBreakpoints as string[]) ?? [];

      for (const name of msgBps) {
        breakpoints.push({ type: "message", value: name });
      }
      for (const loc of srcLocs) {
        breakpoints.push({ type: "sourceLine", value: `${loc.file}:${loc.line}`, file: loc.file, line: loc.line });
      }
      for (const kind of kindBps) {
        breakpoints.push({ type: "stateKind", value: kind });
      }
    }

    const session = this.sessions.get(sessionId);
    if (session?.compiled?.sourceMap) {
      this.debugController.createSession(sessionId, session.compiled.sourceMap);
    }

    const resolved = this.debugController.setBreakpoints(sessionId, breakpoints);
    this.sendRap(ws, "BreakpointsResolved", msg.id, { sessionId, resolved });
  }

  private handleDebugCommand(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const sessionId = payload.sessionId as string;
    const command = payload.command as string;

    if (this.clusterDebugSessions.has(sessionId)) {
      // Forward full payload to all adapter nodes
      for (const adapter of this.adapters.values()) {
        if (adapter.ws.readyState === WebSocket.OPEN) {
          adapter.ws.send(JSON.stringify({ rap: "DebugCommand", payload }));
        }
      }
      if (command === "stop") {
        this.clusterDebugSessions.delete(sessionId);
      }
    } else {
      switch (command) {
        case "continue":
          this.debugController.continue(sessionId);
          break;
        case "stepMessage":
          this.debugController.stepMessage(sessionId);
          break;
        case "stepState":
        case "stepIntoScatter":
        case "stepIntoInvoke":
          this.debugController.stepState(sessionId);
          break;
        case "stepOver":
        case "stepOverScatter":
        case "stepOverInvoke":
          this.debugController.stepOver(sessionId);
          break;
        case "stepOutScatter":
        case "stepOutInvoke":
          this.debugController.continue(sessionId);
          break;
        case "stop":
          this.debugController.destroySession(sessionId);
          break;
        default:
          break;
      }
    }

    this.sendRap(ws, "DebugAck", msg.id, { sessionId, command });
  }

  private handleGetState(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const sessionId = payload.sessionId as string;
    const agentName = payload.agentName as string;
    const requestId = payload.requestId as string | undefined;

    const session = this.sessions.get(sessionId);
    if (!session?.rc) {
      this.sendRap(ws, "InspectError", msg.id, { agentName, error: "Session not found", requestId });
      return;
    }

    const handle = session.rc.getAgent(agentName);
    if (!handle) {
      this.sendRap(ws, "InspectError", msg.id, { agentName, error: `Agent ${agentName} not found`, requestId });
      return;
    }

    const heldMessages = this.debugController.getHeldMessages(sessionId).map(h => ({
      messageName: h.envelope.messageName,
      direction: h.direction,
      from: h.envelope.from,
      to: h.envelope.to,
    }));

    const agentView = this.currentView.agents.find(a => a.agentName === agentName);
    const protoName = agentView?.protocolName;
    let resolveBindings: Record<string, unknown> | undefined;
    let participants: unknown[] | undefined;

    if (protoName && session.rc) {
      const protoEntry = session.rc.listProtocols().find(p => p.name === protoName);
      if (protoEntry) {
        for (const graph of protoEntry.irGraphs.values()) {
          if (graph.protocolName === protoName && graph.participants) {
            participants = graph.participants;
            break;
          }
        }
        for (const trigger of protoEntry.triggers) {
          if (trigger.resolveMap) {
            resolveBindings = {};
            for (const [role, policy] of Object.entries(trigger.resolveMap)) {
              const agents = session.rc.listProtocols()
                .find(p => p.name === protoName)
                ?.irGraphs.values();
              const boundAgentNames: string[] = [];
              for (const av of this.currentView.agents) {
                if (av.protocolName === protoName && av.roleName === role) {
                  boundAgentNames.push(av.agentName);
                }
              }
              (resolveBindings as Record<string, unknown>)[role] = {
                policy,
                boundAgents: boundAgentNames,
              };
            }
            break;
          }
        }
      }
    }

    this.sendRap(ws, "StateSnapshot", msg.id, {
      requestId,
      agentName,
      ctx: (handle as any).getCtx?.() ?? {},
      self: handle.getSelf(),
      recentTraces: session.traces.slice(-20),
      heldMessages,
      resolveBindings,
      participants,
    });
  }

  // ── Adapter management ───────────────────────────────────────────

  /** Maps agentName → nodeId for cross-node envelope routing. */
  private agentToNode = new Map<string, string>();

  private handleAdapterRegister(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const nodeId = payload.nodeId as string;
    const supportedLangs = (payload.supportedLangs as string[]) ?? ["ts"];
    const requestedAgents = (payload.requestedAgents as string[]) ?? [];

    if (!nodeId) {
      this.sendRap(ws, "Rejected", msg.id, { reason: "Missing nodeId" });
      return;
    }

    const adapter: AdapterInfo = {
      nodeId,
      ws,
      supportedLangs,
      deployedAgents: [],
      requestedAgents,
    };
    this.adapters.set(nodeId, adapter);

    // Populate RegistryView with the new node
    const existingNode = this.currentView.nodes.find(n => n.nodeId === nodeId);
    if (existingNode) {
      existingNode.status = "connected";
      existingNode.lastSeen = Date.now();
    } else {
      this.currentView.nodes.push({ nodeId, status: "connected", lastSeen: Date.now() });
    }

    // Clean up on disconnect: remove node, agents, and orphaned debug sessions
    ws.on("close", () => {
      this.adapters.delete(nodeId);
      this.currentView.nodes = this.currentView.nodes.filter(n => n.nodeId !== nodeId);
      this.currentView.agents = this.currentView.agents.filter(a => a.nodeId !== nodeId);
      for (const [agent, nid] of this.agentToNode) {
        if (nid === nodeId) this.agentToNode.delete(agent);
      }

      // If no adapter nodes remain, clean up all cluster debug sessions
      const liveAdapters = [...this.adapters.values()].filter(a => a.ws.readyState === WebSocket.OPEN);
      if (liveAdapters.length === 0 && this.clusterDebugSessions.size > 0) {
        this.clusterDebugSessions.clear();
      }

      this.broadcastClusterUpdate();
    });

    this.sendRap(ws, "Accepted", msg.id, { nodeId });
    this.broadcastClusterUpdate();

    this.deployUnassignedAgentsToNode(nodeId);
  }

  /**
   * Deploy agents from the last deployment to a newly joined node.
   * If the node declared requestedAgents, only deploy those.
   * Agents already confirmed on another node are skipped unless
   * this node explicitly requests them (agent migration).
   */
  private deployUnassignedAgentsToNode(nodeId: string): void {
    if (!this.lastDeployment) return;
    const adapter = this.adapters.get(nodeId);
    if (!adapter || adapter.ws.readyState !== WebSocket.OPEN) return;

    const confirmedAgents = new Set<string>();
    for (const a of this.adapters.values()) {
      for (const name of a.deployedAgents) confirmedAgents.add(name);
    }

    for (const agentDef of this.lastDeployment.agents) {
      const wantsThisAgent = adapter.requestedAgents.length === 0 ||
        adapter.requestedAgents.includes(agentDef.agentName);
      if (!wantsThisAgent) continue;
      if (confirmedAgents.has(agentDef.agentName)) continue;

      const roleName = agentDef.roleName;
      const roleIR = this.deployedRoleIRs[roleName] ?? this.deployedRoleIRs[`${roleName}.role`] ?? {};
      const agentGraphs: Record<string, any> = {};
      for (const binding of agentDef.roles) {
        const key = `${binding.protocolName}.${binding.roleName}`;
        if (this.deployedIRGraphs[key]) agentGraphs[key] = this.deployedIRGraphs[key];
      }

      try {
        const firstRole = agentDef.roles[0];
        adapter.ws.send(JSON.stringify({
          rap: "Deploy",
          payload: {
            agentName: agentDef.agentName,
            roleIR,
            graphs: agentGraphs,
            roleToAgent: this.lastDeployment.roleToAgent,
            roleName,
            protocolName: firstRole?.protocolName ?? "",
            agentRegistrations: this.deployedAgentRegistrations,
          },
        }));
        this.agentToNode.set(agentDef.agentName, nodeId);
        console.log(`[ROS] Auto-deployed ${agentDef.agentName} to late-joining node ${nodeId}`);
      } catch (err) {
        console.error(`[ROS] Failed to auto-deploy ${agentDef.agentName} to ${nodeId}:`, err);
      }
    }

    this.broadcastClusterUpdate();
  }

  private handleAdapterDeployed(_ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const nodeId = payload.nodeId as string;
    const agentName = payload.agentName as string;
    const adapter = this.adapters.get(nodeId);
    if (adapter && !adapter.deployedAgents.includes(agentName)) {
      adapter.deployedAgents.push(agentName);
    }

    this.agentToNode.set(agentName, nodeId);

    const existing = this.currentView.agents.find(a => a.agentName === agentName && a.nodeId === nodeId);
    if (existing) {
      existing.status = "running";
      if (!existing.roleName && payload.roleName) existing.roleName = payload.roleName as string;
      if (!existing.protocolName && payload.protocolName) existing.protocolName = payload.protocolName as string;
    } else {
      const regMeta = this.deployedAgentRegistrations[agentName];
      this.currentView.agents.push({
        agentName,
        roleName: (payload.roleName as string) ?? "",
        protocolName: (payload.protocolName as string) ?? "",
        nodeId,
        status: "running",
        tags: regMeta?.tags,
        capabilities: regMeta?.capabilities,
        labels: regMeta?.labels,
      });
    }

    // Keep protocol boundAgents in sync
    const protoName = (existing?.protocolName || payload.protocolName) as string;
    if (protoName) {
      const proto = this.currentView.protocols.find(p => p.name === protoName);
      if (proto && !proto.boundAgents.includes(agentName)) {
        proto.boundAgents.push(agentName);
      }
    }

    this.broadcastClusterUpdate();
  }

  private handleAdapterTrace(_ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const kind = payload.kind ?? "trace";
    const agent = payload.agent ?? payload.agentName ?? "";
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const messageName = data.messageName ?? "";
    let detail = `${kind} ${agent}`;
    if (messageName) detail += ` msg=${messageName}`;
    if (data.to) detail += ` → ${data.to}`;
    if (data.from) detail += ` ← ${data.from}`;
    console.log(`[ROS] trace: ${detail}`);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ rap: "TraceEvent", payload }));
      }
    }
  }

  /** Broadcast cluster status change to all connected clients. */
  private broadcastClusterUpdate(): void {
    this.currentView.timestamp = Date.now();
    const msg = JSON.stringify({
      rap: "ClusterUpdate",
      payload: {
        nodes: this.currentView.nodes,
        protocols: this.currentView.protocols,
        agents: this.currentView.agents,
        timestamp: this.currentView.timestamp,
      },
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /** Broadcast an arbitrary RAP event to all connected clients. */
  private broadcastToClients(rapType: string, payload: Record<string, unknown>): void {
    const msg = JSON.stringify({ rap: rapType, payload });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /**
   * Deploy an agent to a remote adapter node.
   */
  deployToAdapter(
    nodeId: string,
    sessionId: string,
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    roleToAgent: Record<string, string>,
  ): void {
    const adapter = this.adapters.get(nodeId);
    if (!adapter) throw new Error(`No adapter registered with nodeId ${nodeId}`);

    const graphsObj: Record<string, any> = {};
    for (const [k, v] of graphs) graphsObj[k] = v;

    adapter.ws.send(JSON.stringify({
      rap: "Deploy",
      payload: {
        sessionId,
        agentName,
        roleIR,
        graphs: graphsObj,
        roleToAgent,
      },
    }));
  }

  /**
   * Trigger a protocol on a remote adapter node.
   */
  triggerOnAdapter(
    nodeId: string,
    agentName: string,
    trigger: {
      instanceId: string;
      protocolName: string;
      input?: Record<string, unknown>;
      roleToAgent?: Record<string, string>;
      resolveOverrides?: Record<string, unknown>;
      mode?: string;
      sessionId?: string;
      breakpoints?: string[];
    },
  ): void {
    const adapter = this.adapters.get(nodeId);
    if (!adapter) return;

    const payload: Record<string, unknown> = {
      agentName,
      instanceId: trigger.instanceId,
      protocolName: trigger.protocolName,
      input: trigger.input,
      roleToAgent: trigger.roleToAgent,
    };
    if (trigger.resolveOverrides) payload.resolveOverrides = trigger.resolveOverrides;
    if (trigger.mode) payload.mode = trigger.mode;
    if (trigger.sessionId) payload.sessionId = trigger.sessionId;
    if (trigger.breakpoints?.length) payload.breakpoints = trigger.breakpoints;

    adapter.ws.send(JSON.stringify({ rap: "TriggerProtocol", payload }));
  }

  getAdapters(): Map<string, AdapterInfo> {
    return this.adapters;
  }

  // ── Reconciler RAP handlers (10-14) ──────────────────────────────

  private currentView: RegistryView = createEmptyView();
  private currentSpec: DeploySpec | null = null;
  private lastPlan: ReconciliationPlan | null = null;
  private deployedIRGraphs: Record<string, any> = {};
  private deployedRoleIRs: Record<string, any> = {};
  private deployedAgentRegistrations: Record<string, { tags?: string[]; capabilities?: string[]; labels?: Record<string, string> }> = {};
  private lastDeployment: {
    agents: Array<{ agentName: string; lang: string; roleName: string; roles: Array<{ protocolName: string; roleName: string }> }>;
    roleToAgent: Record<string, string>;
  } | null = null;

  private handleListProtocols(ws: WebSocket, msg: RAPMessage): void {
    const session = this.sessions.getLatest();
    if (!session?.rc) {
      this.sendRap(ws, "ListProtocolsResponse", msg.id, {
        requestId: msg.payload?.requestId ?? msg.id,
        nodeId: "ros-local",
        protocols: [],
      });
      return;
    }

    const registry = session.rc.registry;
    const protocols = registry.list().map((entry: any) => ({
      name: entry.name,
      version: entry.version,
      fingerprints: entry.fingerprints,
      dependencies: entry.dependencies,
      boundAgents: registry.agentsForProtocol(entry.name),
    }));

    this.sendRap(ws, "ListProtocolsResponse", msg.id, {
      requestId: msg.payload?.requestId ?? msg.id,
      nodeId: "ros-local",
      protocols,
    });
  }

  private handleGetDeployedIR(ws: WebSocket, msg: RAPMessage): void {
    const protocolName = (msg.payload?.protocolName as string) || undefined;
    let irGraphs = this.deployedIRGraphs;
    let roleIRs = this.deployedRoleIRs;

    if (protocolName) {
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(irGraphs)) {
        if (k.startsWith(protocolName + '.') || (v as any)?.protocolName === protocolName) {
          filtered[k] = v;
        }
      }
      irGraphs = filtered;
    }

    const version = this.currentView.protocols.find(
      p => p.name === (protocolName || '')
    )?.version ?? `1.0.${this._deployGeneration}`;

    this.sendRap(ws, "DeployedIR", msg.id, {
      irGraphs,
      roleIRs,
      version,
    });
  }

  private handleDeployProtocol(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const protoName = payload.protocolName as string;
    const version = payload.version as string;

    const session = this.sessions.getLatest();
    if (!session?.rc) {
      this.sendRap(ws, "DeployProtocolFailed", msg.id, {
        requestId: payload.requestId ?? msg.id,
        protocolName: protoName,
        error: "No active session with RC",
      });
      return;
    }

    try {
      const irGraphs = payload.irGraphs as Record<string, any> | undefined;
      if (irGraphs) {
        const graphMap = new Map<string, IRGraph>();
        for (const [k, v] of Object.entries(irGraphs)) {
          graphMap.set(k, v as IRGraph);
        }

        const compat = session.rc.registry.canDeploy({
          name: protoName,
          version,
          fingerprints: payload.fingerprints as any ?? { structureHash: "", schemaHash: "", implHash: "" },
          dependencies: (payload.dependencies as any) ?? [],
          irGraphs: graphMap,
          triggers: [],
          invocable: false,
          registeredAt: Date.now(),
        });

        if (!compat.compatible) {
          const reasons = [...compat.details, ...compat.dependencyConflicts.map((c: any) => c.message)];
          this.sendRap(ws, "DeployProtocolFailed", msg.id, {
            requestId: payload.requestId ?? msg.id,
            protocolName: protoName,
            error: `Incompatible: ${reasons.join("; ")}`,
          });
          return;
        }
      }

      this.sendRap(ws, "DeployProtocolSuccess", msg.id, {
        requestId: payload.requestId ?? msg.id,
        protocolName: protoName,
        version,
      });
    } catch (err) {
      this.sendRap(ws, "DeployProtocolFailed", msg.id, {
        requestId: payload.requestId ?? msg.id,
        protocolName: protoName,
        error: String(err),
      });
    }
  }

  private handleClusterStatus(ws: WebSocket, msg: RAPMessage): void {
    this.sendRap(ws, "ClusterStatusResponse", msg.id, {
      requestId: msg.payload?.requestId ?? msg.id,
      nodes: this.currentView.nodes,
      protocols: this.currentView.protocols,
      agents: this.currentView.agents,
      timestamp: Date.now(),
    });
  }

  private handleListAgents(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const role = payload.role as string | undefined;
    const protocolName = payload.protocolName as string | undefined;
    const status = payload.status as string | undefined;
    const filterExpr = payload.filter as string | undefined;
    const limit = Math.min((payload.limit as number) ?? 100, 1000);
    const offset = (payload.offset as number) ?? 0;

    let agents = [...this.currentView.agents];

    if (role) agents = agents.filter(a => a.roleName === role);
    if (protocolName) agents = agents.filter(a => a.protocolName === protocolName);
    if (status) agents = agents.filter(a => a.status === status);

    if (filterExpr) {
      agents = agents.filter(a => {
        try {
          return this.evaluateAgentFilter(filterExpr, a);
        } catch {
          return false;
        }
      });
    }

    const total = agents.length;
    const paged = agents.slice(offset, offset + limit);

    this.sendRap(ws, "ListAgentsResponse", msg.id, {
      requestId: payload.requestId ?? msg.id,
      agents: paged,
      total,
    });
  }

  private evaluateAgentFilter(expr: string, agent: RegistryAgentEntry): boolean {
    const lower = expr.trim().toLowerCase();

    const containsMatch = lower.match(/^agent\.tags\s+contains\s+'([^']+)'$/);
    if (containsMatch) {
      return agent.tags?.includes(containsMatch[1]) ?? false;
    }

    const capMatch = lower.match(/^agent\.capabilities\s+contains\s+'([^']+)'$/);
    if (capMatch) {
      return agent.capabilities?.includes(capMatch[1]) ?? false;
    }

    const labelMatch = lower.match(/^agent\.labels\.(\w+)\s*==\s*'([^']+)'$/);
    if (labelMatch) {
      return agent.labels?.[labelMatch[1]] === labelMatch[2];
    }

    const nameMatch = lower.match(/^agent\.name\s*==\s*'([^']+)'$/);
    if (nameMatch) {
      return agent.agentName === nameMatch[1];
    }

    return true;
  }

  private handleSubmitDeploySpec(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const spec = payload.deploySpec as DeploySpec | undefined;

    if (!spec) {
      this.sendRap(ws, "SubmitDeploySpecRejected", msg.id, {
        requestId: payload.requestId ?? msg.id,
        error: "Missing deploySpec in payload",
        conflicts: [],
      });
      return;
    }

    this.currentSpec = spec;
    const plan = reconcile(spec, this.currentView);
    this.lastPlan = plan;

    if (plan.conflicts.length > 0) {
      this.sendRap(ws, "SubmitDeploySpecRejected", msg.id, {
        requestId: payload.requestId ?? msg.id,
        error: "Reconciliation has conflicts",
        conflicts: plan.conflicts,
      });
      return;
    }

    const summary = planSummary(plan);
    this.sendRap(ws, "SubmitDeploySpecAccepted", msg.id, {
      requestId: payload.requestId ?? msg.id,
      deploymentId: spec.deploymentId,
      planSummary: summary,
      actionCount: plan.actions.length,
      conflictCount: plan.conflicts.length,
    });
  }

  private async handleStopAgent(ws: WebSocket, msg: RAPMessage): Promise<void> {
    const payload = msg.payload ?? {};
    const agentName = payload.agentName as string;

    const session = this.sessions.getLatest();
    if (!session?.rc) {
      this.sendRap(ws, "StopAgentFailed", msg.id, {
        requestId: payload.requestId ?? msg.id,
        agentName,
        error: "No active session",
      });
      return;
    }

    try {
      await session.rc.destroyAgent(agentName);
      this.sendRap(ws, "StopAgentSuccess", msg.id, {
        requestId: payload.requestId ?? msg.id,
        agentName,
      });
    } catch (err) {
      this.sendRap(ws, "StopAgentFailed", msg.id, {
        requestId: payload.requestId ?? msg.id,
        agentName,
        error: String(err),
      });
    }
  }

  // ── Distributed deployment ──────────────────────────────────────

  /**
   * DeployProject: client sends compiled IR (deployment.json + graphs + roleIRs),
   * ROS distributes agents across connected adapter nodes.
   */
  private async handleDeployProject(ws: WebSocket, msg: RAPMessage): Promise<void> {
    const payload = msg.payload ?? {};
    const deployment = payload.deployment as {
      agents: Array<{
        agentName: string;
        lang: string;
        roleName: string;
        roleIRFile?: string;
        roles: Array<{ protocolName: string; roleName: string; irGraphFile?: string }>;
      }>;
      roleToAgent: Record<string, string>;
    } | undefined;

    if (!deployment) {
      this.sendRap(ws, "DeployProjectFailed", msg.id, { error: "Missing deployment in payload" });
      return;
    }

    const irGraphs = (payload.irGraphs ?? {}) as Record<string, any>;
    const roleIRs = (payload.roleIRs ?? {}) as Record<string, any>;
    const roleToAgent = deployment.roleToAgent;
    const sourceMap = payload.sourceMap as { entries: Array<{ stateId: string; protocolName: string; role: string; file: string; line: number; column: number }> } | undefined;
    const projectVersion = (payload.projectVersion as string) || undefined;

    this.deployedIRGraphs = irGraphs;
    this.deployedRoleIRs = roleIRs;
    this.lastDeployment = deployment as any;

    const agentRegs = (payload.agentRegistrations ?? {}) as Record<string, { tags?: string[]; capabilities?: string[]; labels?: Record<string, string> }>;
    Object.assign(this.deployedAgentRegistrations, agentRegs);

    const adapterList = [...this.adapters.values()].filter(a => a.ws.readyState === WebSocket.OPEN);
    if (adapterList.length === 0) {
      this.sendRap(ws, "DeployProjectFailed", msg.id, {
        error: "No connected adapter nodes. Start at least one remote node first.",
      });
      return;
    }

    // Update source map for all active debug sessions
    if (sourceMap && this.debugController) {
      for (const sessionId of this.activeDebugSessions()) {
        this.debugController.updateSourceMap(sessionId, sourceMap);
      }
    }

    // Track deploy generation for protocol versioning
    if (!this._deployGeneration) this._deployGeneration = 0;
    this._deployGeneration++;

    // Add or update protocols in RegistryView
    const seenProtos = new Set<string>();
    const resolvedVersion = projectVersion ?? `1.0.${this._deployGeneration}`;
    for (const agent of deployment.agents) {
      for (const role of agent.roles) {
        if (seenProtos.has(role.protocolName)) continue;
        seenProtos.add(role.protocolName);
        const existing = this.currentView.protocols.find(
          p => p.name === role.protocolName
        );
        if (existing) {
          existing.version = resolvedVersion;
        } else {
          this.currentView.protocols.push({
            name: role.protocolName,
            version: resolvedVersion,
            fingerprints: { structureHash: "", schemaHash: "", implHash: "" },
            dependencies: [],
            nodeId: "ros",
            boundAgents: [],
          });
        }
      }
    }

    // Agent-to-adapter routing: prefer adapters that requested specific agents,
    // fall back to round-robin for unmatched agents.
    let adapterIdx = 0;
    const deployedCount = { success: 0, total: deployment.agents.length };

    for (const agentDef of deployment.agents) {
      const preferred = adapterList.find(a =>
        a.requestedAgents.length > 0 && a.requestedAgents.includes(agentDef.agentName)
      );
      const adapter = preferred ?? adapterList[adapterIdx % adapterList.length];
      if (!preferred) adapterIdx++;

      const roleName = agentDef.roleName;
      const roleIR = roleIRs[roleName] ?? roleIRs[`${roleName}.role`] ?? {};

      const agentGraphs: Record<string, any> = {};
      for (const binding of agentDef.roles) {
        const key = `${binding.protocolName}.${binding.roleName}`;
        if (irGraphs[key]) agentGraphs[key] = irGraphs[key];
      }

      try {
        const firstRole = agentDef.roles[0];
        adapter.ws.send(JSON.stringify({
          rap: "Deploy",
          payload: {
            agentName: agentDef.agentName,
            roleIR,
            graphs: agentGraphs,
            roleToAgent,
            roleName,
            protocolName: firstRole?.protocolName ?? "",
            protocolVersion: resolvedVersion,
            agentRegistrations: agentRegs,
          },
        }));
        this.agentToNode.set(agentDef.agentName, adapter.nodeId);

        // Pre-populate agent in cluster view (Deployed ack may lack protocol info)
        const regMeta = this.deployedAgentRegistrations[agentDef.agentName];
        for (const binding of agentDef.roles) {
          const existing = this.currentView.agents.find(
            a => a.agentName === agentDef.agentName && a.nodeId === adapter.nodeId
          );
          if (!existing) {
            this.currentView.agents.push({
              agentName: agentDef.agentName,
              roleName: binding.roleName,
              protocolName: binding.protocolName,
              nodeId: adapter.nodeId,
              status: "deploying",
              tags: regMeta?.tags,
              capabilities: regMeta?.capabilities,
              labels: regMeta?.labels,
            });
          }
        }

        deployedCount.success++;
      } catch (err) {
        console.error(`[ROS] Failed to deploy ${agentDef.agentName} to ${adapter.nodeId}:`, err);
      }
    }

    // Populate boundAgents on each protocol entry
    for (const proto of this.currentView.protocols) {
      const bound = this.currentView.agents
        .filter(a => a.protocolName === proto.name)
        .map(a => a.agentName);
      proto.boundAgents = [...new Set(bound)];
    }

    this.broadcastClusterUpdate();

    // Broadcast updated source map so active debug sessions can resolve new breakpoints
    if (sourceMap) {
      this.broadcastToClients("SourceMapUpdated", { sourceMap });
    }

    this.sendRap(ws, "DeployProjectSuccess", msg.id, {
      deployed: deployedCount.success,
      total: deployedCount.total,
      adapterCount: adapterList.length,
    });
  }

  /**
   * TriggerOnCluster: client triggers a protocol on the distributed cluster.
   * ROS finds which adapter node hosts the initiator and sends TriggerProtocol.
   */
  private handleTriggerOnCluster(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const agentName = payload.agentName as string;
    const instanceId = (payload.instanceId as string) ?? randomUUID();
    const protocolName = payload.protocolName as string;
    const input = (payload.input as Record<string, unknown>) ?? {};
    const mode = (payload.mode as string) ?? "run";
    const sessionId = mode === "debug" ? ((payload.sessionId as string) ?? randomUUID()) : undefined;
    const breakpoints = (payload.breakpoints as string[]) ?? [];
    const resolveOverrides = payload.resolveOverrides as Record<string, unknown> | undefined;

    if (!agentName || !protocolName) {
      this.sendRap(ws, "TriggerFailed", msg.id, {
        error: "Missing agentName or protocolName",
      });
      return;
    }

    // Build global roleToAgent from all deployed agents
    const globalRoleToAgent: Record<string, string> = {};
    for (const adapter of this.adapters.values()) {
      for (const aName of adapter.deployedAgents) {
        const agentView = this.currentView.agents.find(a => a.agentName === aName);
        if (agentView) {
          const key = `${agentView.protocolName}.${agentView.roleName}`;
          globalRoleToAgent[key] = aName;
        }
      }
    }

    const nodeId = this.agentToNode.get(agentName);
    if (!nodeId) {
      this.sendRap(ws, "TriggerFailed", msg.id, {
        error: `Agent ${agentName} not deployed on any node`,
      });
      return;
    }

    const adapter = this.adapters.get(nodeId);
    if (!adapter || adapter.ws.readyState !== WebSocket.OPEN) {
      this.sendRap(ws, "TriggerFailed", msg.id, {
        error: `Adapter node ${nodeId} is not connected`,
      });
      return;
    }

    // Trigger on the initiator's node
    this.triggerOnAdapter(nodeId, agentName, {
      instanceId,
      protocolName,
      input,
      roleToAgent: globalRoleToAgent,
      resolveOverrides,
      mode,
      sessionId,
      breakpoints,
    });

    // Also trigger on all other nodes that have agents playing roles in this protocol
    for (const [nid, adapterInfo] of this.adapters) {
      if (nid === nodeId) continue;
      if (adapterInfo.ws.readyState !== WebSocket.OPEN) continue;
      const hasRelevantAgent = adapterInfo.deployedAgents.some(aName => {
        const av = this.currentView.agents.find(a => a.agentName === aName && a.protocolName === protocolName);
        return !!av;
      });
      if (hasRelevantAgent) {
        for (const aName of adapterInfo.deployedAgents) {
          const av = this.currentView.agents.find(a => a.agentName === aName && a.protocolName === protocolName);
          if (av) {
            this.triggerOnAdapter(nid, aName, {
              instanceId,
              protocolName,
              input,
              roleToAgent: globalRoleToAgent,
              resolveOverrides,
              mode,
              sessionId,
              breakpoints,
            });
          }
        }
      }
    }

    if (sessionId) {
      this.clusterDebugSessions.add(sessionId);
    }

    this.sendRap(ws, "TriggerAck", msg.id, {
      instanceId,
      protocolName,
      agentName,
      sessionId,
    });
  }

  // ── Node introspection ───────────────────────────────────────────

  /** Pending NodeInspect requests: requestId → client ws */
  private pendingInspects = new Map<string, WebSocket>();

  private handleNodeInspect(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const nodeId = payload.nodeId as string;
    if (!nodeId) {
      this.sendRap(ws, "NodeInspectResult", msg.id, { error: "Missing nodeId" });
      return;
    }

    const adapter = this.adapters.get(nodeId);
    if (!adapter || adapter.ws.readyState !== WebSocket.OPEN) {
      this.sendRap(ws, "NodeInspectResult", msg.id, { error: `Node ${nodeId} not connected` });
      return;
    }

    const requestId = msg.id ?? randomUUID();
    this.pendingInspects.set(requestId, ws);

    adapter.ws.send(JSON.stringify({ rap: "NodeInspect", id: requestId, payload: {} }));
  }

  private handleNodeInspectResult(_ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const requestId = (payload.requestId as string) ?? msg.id ?? "";
    const client = this.pendingInspects.get(requestId);
    this.pendingInspects.delete(requestId);
    if (client && client.readyState === WebSocket.OPEN) {
      this.sendRap(client, "NodeInspectResult", requestId, payload);
    }
  }

  /**
   * DebugStopped: forwarded from adapter nodes during cluster debug sessions.
   * Broadcast to all non-adapter clients as a "Stopped" event.
   */
  private handleDebugStopped(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const stoppedMsg = JSON.stringify({ rap: "Stopped", payload });
    for (const client of this.clients) {
      if (client === ws) continue;
      if (client.readyState === WebSocket.OPEN) {
        client.send(stoppedMsg);
      }
    }
  }

  /**
   * RouteEnvelope: relay a message envelope from one node to another.
   * The sending node couldn't resolve the target agent locally.
   */
  private handleRouteEnvelope(_ws: WebSocket, msg: RAPMessage): void {
    const envelope = (msg.payload ?? {}) as Record<string, unknown>;
    const target = (envelope.to as Record<string, string>)?.agent;
    if (!target) return;

    const nodeId = this.agentToNode.get(target);
    if (!nodeId) {
      console.warn(`[ROS] RouteEnvelope: no node for agent ${target}`);
      return;
    }

    const adapter = this.adapters.get(nodeId);
    if (!adapter || adapter.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[ROS] RouteEnvelope: adapter ${nodeId} not connected`);
      return;
    }

    // Forward the envelope directly (not wrapped in RAP — RemoteNode handles raw envelopes)
    adapter.ws.send(JSON.stringify(envelope));
  }
}
