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
}

export class ReagentOrchestratorServer {
  private wss: WebSocketServer | null = null;
  private sessions: SessionManager;
  private config: ROSConfig;
  private clients = new Set<WebSocket>();
  private debugController: DebugController;
  private adapters = new Map<string, AdapterInfo>();

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

  async start(): Promise<number> {
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
    ws.send(JSON.stringify({ rap, id, payload }));
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: RAPMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Check for adapter handshake (nodeId field)
    if ((msg as any).nodeId && !msg.rap) {
      this.handleAdapterHandshake(ws, msg as any);
      return;
    }

    switch (msg.rap) {
      case "Compile":
        this.handleCompile(ws, msg);
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

    if (isDebugMode) {
      const debugInstruments = this.debugController.createSession(
        session.sessionId,
        compiled.sourceMap,
      );
      debugAdvanceHook = debugInstruments.advanceHook;
      interceptors.push(debugInstruments.interceptorFn);
    }

    const traceHook: TraceHook = (event: TraceEvent) => {
      session.pushTrace(event);
      this.sendRap(ws, "TraceEvent", undefined, event as unknown as Record<string, unknown>);
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

    // Wait for completion or timeout
    await Promise.race([
      completionPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 30000)),
    ]);

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

  // ── Debug handlers ────────────────────────────────────────────────

  private handleSetBreakpoints(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const sessionId = payload.sessionId as string;
    const breakpoints = (payload.breakpoints as Breakpoint[]) ?? [];

    // Ensure debug session exists with source map from compiled artifacts
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

    switch (command) {
      case "continue":
        this.debugController.continue(sessionId);
        break;
      case "stepMessage":
        this.debugController.stepMessage(sessionId);
        break;
      case "stepState":
        this.debugController.stepState(sessionId);
        break;
      case "stepOver":
        this.debugController.stepOver(sessionId);
        break;
      default:
        break;
    }

    this.sendRap(ws, "DebugAck", msg.id, { sessionId, command });
  }

  private handleGetState(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const sessionId = payload.sessionId as string;
    const agentName = payload.agentName as string;

    const session = this.sessions.get(sessionId);
    if (!session?.rc) {
      this.sendRap(ws, "StateSnapshot", msg.id, { error: "Session not found" });
      return;
    }

    const handle = session.rc.getAgent(agentName);
    if (!handle) {
      this.sendRap(ws, "StateSnapshot", msg.id, { error: `Agent ${agentName} not found` });
      return;
    }

    const heldMessages = this.debugController.getHeldMessages(sessionId).map(h => ({
      messageName: h.envelope.messageName,
      direction: h.direction,
      from: h.envelope.from,
      to: h.envelope.to,
    }));

    this.sendRap(ws, "StateSnapshot", msg.id, {
      agentName,
      self: handle.getSelf(),
      recentTraces: session.traces.slice(-20),
      heldMessages,
    });
  }

  // ── Adapter management ───────────────────────────────────────────

  private handleAdapterHandshake(ws: WebSocket, msg: { nodeId: string; supportedLangs?: string[] }): void {
    const adapter: AdapterInfo = {
      nodeId: msg.nodeId,
      ws,
      supportedLangs: msg.supportedLangs ?? ["ts"],
      deployedAgents: [],
    };
    this.adapters.set(msg.nodeId, adapter);
    this.sendRap(ws, "HandshakeAck", undefined, { nodeId: msg.nodeId });
  }

  private handleAdapterRegister(ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const nodeId = payload.nodeId as string;
    const supportedLangs = (payload.supportedLangs as string[]) ?? ["ts"];

    const adapter: AdapterInfo = {
      nodeId,
      ws,
      supportedLangs,
      deployedAgents: [],
    };
    this.adapters.set(nodeId, adapter);
    this.sendRap(ws, "RegisterAck", msg.id, { nodeId });
  }

  private handleAdapterDeployed(_ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    const nodeId = payload.nodeId as string;
    const agentName = payload.agentName as string;
    const adapter = this.adapters.get(nodeId);
    if (adapter) {
      adapter.deployedAgents.push(agentName);
    }
  }

  private handleAdapterTrace(_ws: WebSocket, msg: RAPMessage): void {
    const payload = msg.payload ?? {};
    // Forward trace events to all API clients (not adapters)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ rap: "TraceEvent", payload }));
      }
    }
  }

  /**
   * Deploy an agent to a remote adapter node.
   */
  deployToAdapter(
    nodeId: string,
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
    trigger: { instanceId: string; protocolName: string; input?: Record<string, unknown>; roleToAgent?: Record<string, string> },
  ): void {
    const adapter = this.adapters.get(nodeId);
    if (!adapter) return;

    adapter.ws.send(JSON.stringify({
      rap: "TriggerProtocol",
      payload: { agentName, trigger },
    }));
  }

  getAdapters(): Map<string, AdapterInfo> {
    return this.adapters;
  }
}
