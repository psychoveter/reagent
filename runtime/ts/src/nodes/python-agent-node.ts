/**
 * PythonAgentNode — runs Python agents as child processes with JSON-line IPC.
 *
 * Each agent gets its own Python subprocess running ipc_agent.py.
 * The TS side (PythonAgentHandle) bridges stdin/stdout JSON lines to
 * the AgentHandle interface expected by the ReagentController.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as RLInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { RoleIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "../contracts/types.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { AgentNode, AgentHandle } from "../contracts/agent-node.js";
import type { TraceHook } from "../contracts/interceptor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PY_RUNTIME = join(__dirname, "..", "..", "..", "py");

// ── Config ──────────────────────────────────────────────────────────

export interface PythonAgentNodeConfig {
  roleToAgent: Record<string, string>;
  /** Absolute path to the Python binary (must have reagent_runtime importable). */
  pythonBin?: string;
  /** Path to the py runtime dir (default: runtime/py relative to this file). */
  pyRuntimeDir?: string;
  traceHook?: TraceHook;
}

// ── IPC message types ───────────────────────────────────────────────

type IpcOutbound =
  | { type: "init"; agentName: string; agentIR: unknown; graphs: unknown; roleToAgent: Record<string, string> }
  | { type: "start" }
  | { type: "dispatchMessage"; envelope: MessageEnvelope }
  | { type: "triggerProtocol"; trigger: ProtocolTrigger }
  | { type: "getSelf" }
  | { type: "stop" };

type IpcInbound =
  | { type: "ready" }
  | { type: "sendEnvelope"; envelope: MessageEnvelope }
  | { type: "trace"; event: unknown }
  | { type: "selfState"; state: Record<string, unknown> }
  | { type: "instanceCompleted"; instanceId: string; status: string }
  | { type: "stopped" };

// ── PythonAgentNode ─────────────────────────────────────────────────

export class PythonAgentNode implements AgentNode {
  readonly runtimeName = "python";
  private roleToAgent: Record<string, string>;
  private pythonBin: string;
  private pyRuntimeDir: string;
  private traceHook?: TraceHook;

  constructor(config: PythonAgentNodeConfig) {
    this.roleToAgent = config.roleToAgent;
    this.pyRuntimeDir = config.pyRuntimeDir ?? DEFAULT_PY_RUNTIME;
    this.pythonBin = config.pythonBin ?? join(this.pyRuntimeDir, ".venv", "bin", "python");
    this.traceHook = config.traceHook;
  }

  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
  ): AgentHandle {
    const agentIR = {
      agentName,
      lang: roleIR.lang ?? "py",
      roleName: roleIR.roleName,
      plays: roleIR.plays,
      initAction: roleIR.initAction,
      lifecycleHandlers: roleIR.lifecycleHandlers,
    };

    const graphsObj: Record<string, IRGraph> = {};
    for (const [k, v] of graphs) {
      graphsObj[k] = v;
    }

    return new PythonAgentHandle(
      agentName,
      agentIR,
      graphsObj,
      this.roleToAgent,
      transport,
      this.pythonBin,
      this.pyRuntimeDir,
      this.traceHook,
    );
  }

  async destroyAgent(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }
}

// ── PythonAgentHandle ───────────────────────────────────────────────

export class PythonAgentHandle implements AgentHandle {
  readonly agentName: string;

  private agentIR: unknown;
  private graphsObj: Record<string, IRGraph>;
  private roleToAgent: Record<string, string>;
  private transport: ReagentTransport;
  private pythonBin: string;
  private pyRuntimeDir: string;
  private traceHook?: TraceHook;

  private child: ChildProcess | null = null;
  private rl: RLInterface | null = null;
  private selfState: Record<string, unknown> = {};
  private selfResolvers: Array<(state: Record<string, unknown>) => void> = [];
  private stopResolvers: Array<() => void> = [];
  private readyResolver: (() => void) | null = null;

  private completedCount = 0;
  private completionResolve: (() => void) | null = null;
  private completionExpected = 0;
  private completionTimeout: ReturnType<typeof setTimeout> | null = null;

  private instanceStatuses = new Map<string, string>();

  constructor(
    agentName: string,
    agentIR: unknown,
    graphsObj: Record<string, IRGraph>,
    roleToAgent: Record<string, string>,
    transport: ReagentTransport,
    pythonBin: string,
    pyRuntimeDir: string,
    traceHook?: TraceHook,
  ) {
    this.agentName = agentName;
    this.agentIR = agentIR;
    this.graphsObj = graphsObj;
    this.roleToAgent = roleToAgent;
    this.transport = transport;
    this.pythonBin = pythonBin;
    this.pyRuntimeDir = pyRuntimeDir;
    this.traceHook = traceHook;
  }

  async start(): Promise<void> {
    this.child = spawn(
      this.pythonBin,
      ["-m", "reagent_runtime.ipc_agent"],
      {
        cwd: this.pyRuntimeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONPATH: this.pyRuntimeDir,
        },
      },
    );

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[py:${this.agentName}:stderr] ${text}`);
    });

    this.child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[py:${this.agentName}] exited with code ${code} signal ${signal}`);
      }
    });

    this.rl = createInterface({ input: this.child.stdout! });
    this.rl.on("line", (line: string) => this.handleLine(line));

    // Send init
    const readyPromise = new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });

    this.sendCmd({
      type: "init",
      agentName: this.agentName,
      agentIR: this.agentIR,
      graphs: this.graphsObj,
      roleToAgent: this.roleToAgent,
    });

    await readyPromise;

    // Send start
    this.sendCmd({ type: "start" });

    // Small delay for the Python asyncio loop to finish start()
    await new Promise((r) => setTimeout(r, 50));
  }

  async stop(): Promise<void> {
    if (!this.child) return;

    const stopped = new Promise<void>((resolve) => {
      this.stopResolvers.push(resolve);
    });

    this.sendCmd({ type: "stop" });

    const timeout = setTimeout(() => {
      this.child?.kill("SIGTERM");
      this.stopResolvers.forEach((r) => r());
      this.stopResolvers = [];
    }, 5000);

    await stopped;
    clearTimeout(timeout);

    this.rl?.close();
    this.rl = null;
    this.child = null;
  }

  getSelf(): Record<string, unknown> {
    return this.selfState;
  }

  /** Request fresh $self from the Python process (async). */
  async fetchSelf(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.selfResolvers.push(resolve);
      this.sendCmd({ type: "getSelf" });
    });
  }

  triggerProtocol(trigger: ProtocolTrigger): void {
    this.sendCmd({ type: "triggerProtocol", trigger });
  }

  dispatchMessage(env: MessageEnvelope): void {
    this.sendCmd({ type: "dispatchMessage", envelope: env });
  }

  waitForCompletion(expectedCount: number, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.completionExpected = expectedCount;
      if (this.completedCount >= expectedCount) {
        resolve();
        return;
      }

      this.completionTimeout = setTimeout(() => {
        reject(
          new Error(
            `Timeout: py:${this.agentName} completed ${this.completedCount}/${expectedCount} instances`,
          ),
        );
      }, timeoutMs);

      this.completionResolve = () => {
        if (this.completionTimeout) clearTimeout(this.completionTimeout);
        resolve();
      };
    });
  }

  getInstanceStatus(instanceId: string): string | undefined {
    return this.instanceStatuses.get(instanceId);
  }

  // ── Internal ────────────────────────────────────────────────────

  private sendCmd(cmd: IpcOutbound): void {
    if (!this.child?.stdin?.writable) return;
    const line = JSON.stringify(cmd) + "\n";
    this.child.stdin.write(line);
  }

  private handleLine(line: string): void {
    let msg: IpcInbound;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    switch (msg.type) {
      case "ready":
        this.readyResolver?.();
        this.readyResolver = null;
        break;

      case "sendEnvelope":
        this.transport.ref(msg.envelope.to.agent).sendEnvelope(msg.envelope);
        break;

      case "trace":
        if (this.traceHook) this.traceHook(msg.event as any);
        break;

      case "selfState":
        this.selfState = msg.state;
        if (this.selfResolvers.length > 0) {
          const resolver = this.selfResolvers.shift()!;
          resolver(msg.state);
        }
        break;

      case "instanceCompleted":
        this.completedCount++;
        this.instanceStatuses.set(msg.instanceId, msg.status);
        if (this.completedCount >= this.completionExpected) {
          this.completionResolve?.();
          this.completionResolve = null;
        }
        break;

      case "stopped":
        this.stopResolvers.forEach((r) => r());
        this.stopResolvers = [];
        break;
    }
  }
}
