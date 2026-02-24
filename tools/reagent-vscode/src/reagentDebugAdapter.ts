import * as vscode from 'vscode';
import { RapClient } from './rapClient';
import { ReagentDebugPanelProvider } from './debugPanelProvider';
import { ReagentInlineValues } from './inlineValues';
import type { RosManager } from './rosManager';
import * as fs from 'fs';
import * as path from 'path';

const THREAD_ID = 1;

interface LaunchConfig extends vscode.DebugConfiguration {
  rgFile: string;
  rosHost?: string;
  rosPort?: number;
}

interface SourceMapEntry {
  stateId: string;
  protocolName: string;
  role: string;
  file: string;
  line: number;
  column: number;
}

export interface DebugSinks {
  debugPanel: ReagentDebugPanelProvider;
  inlineValues: ReagentInlineValues;
}

export class ReagentDebugSession implements vscode.DebugAdapter {
  private sendMessage: vscode.EventEmitter<vscode.DebugProtocolMessage> = new vscode.EventEmitter();
  readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessage.event;

  private rap: RapClient | null = null;
  private sessionId: string | null = null;
  private sourceMap: SourceMapEntry[] = [];
  private rgFilePath = '';
  private disposables: vscode.Disposable[] = [];
  private paused = false;
  private stoppedReason = '';
  private stoppedDetail: Record<string, unknown> = {};
  private seq = 0;

  /** Stack of protocol frames when stepping into invoke/spawn children. */
  private protocolStack: Array<{
    protocolName: string;
    role: string;
    stateId: string;
    sessionId: string;
  }> = [];

  /** When inside a scatter, tracks which branch index we're stepping through. */
  private scatterBranchIndex: number | null = null;

  static activeSession: ReagentDebugSession | null = null;

  constructor(private readonly sinks?: DebugSinks, private readonly rosManager?: RosManager) {}

  getRapClient(): RapClient | null { return this.rap; }
  getSessionId(): string | null { return this.sessionId; }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as { type: string; command?: string; seq: number; arguments?: Record<string, unknown> };
    if (msg.type === 'request') {
      this.handleRequest(msg.command!, msg.seq, msg.arguments || {});
    }
  }

  private async handleRequest(command: string, reqSeq: number, args: Record<string, unknown>): Promise<void> {
    try {
      switch (command) {
        case 'initialize':
          this.sendResponse(reqSeq, command, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: false,
            supportsStepBack: false,
            supportsSetVariable: false,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: false,
            supportsStepInTargetsRequest: false,
            supportsCompletionsRequest: false,
            supportsModulesRequest: false,
            supportsExceptionOptions: false,
            supportTerminateDebuggee: true,
          });
          this.sendEvent('initialized', {});
          break;

        case 'launch':
          await this.handleLaunch(reqSeq, args as unknown as LaunchConfig);
          break;

        case 'configurationDone':
          this.sendResponse(reqSeq, command);
          break;

        case 'threads':
          this.sendResponse(reqSeq, command, {
            threads: [{ id: THREAD_ID, name: 'Reagent Protocol' }],
          });
          break;

        case 'stackTrace':
          this.handleStackTrace(reqSeq);
          break;

        case 'scopes':
          this.handleScopes(reqSeq, args);
          break;

        case 'variables':
          await this.handleVariables(reqSeq, args);
          break;

        case 'setBreakpoints':
          await this.handleSetBreakpoints(reqSeq, args);
          break;

        case 'continue':
          await this.handleContinue(reqSeq);
          break;

        case 'next':
          await this.handleStepOver(reqSeq);
          break;

        case 'stepIn':
          await this.handleStepIn(reqSeq);
          break;

        case 'stepOut':
          await this.handleStepOut(reqSeq);
          break;

        case 'pause':
          this.sendResponse(reqSeq, command);
          break;

        case 'disconnect':
          this.handleDisconnect(reqSeq);
          break;

        default:
          this.sendResponse(reqSeq, command);
          break;
      }
    } catch (err) {
      this.sendErrorResponse(reqSeq, command, String(err));
    }
  }

  private async handleLaunch(reqSeq: number, config: LaunchConfig): Promise<void> {
    const rosHost = config.rosHost || '127.0.0.1';
    const rosPort = config.rosPort || 18789;
    this.rgFilePath = config.rgFile;

    this.rap = new RapClient(`ws://${rosHost}:${rosPort}`);
    try {
      await this.rap.connect();
    } catch {
      // Auto-start ROS if available
      if (this.rosManager) {
        const ok = await this.rosManager.ensureRunning();
        if (!ok) {
          this.sendErrorResponse(reqSeq, 'launch', `Cannot start ROS. Check Reagent ROS output.`);
          return;
        }
        try {
          this.rap = new RapClient(`ws://${rosHost}:${rosPort}`);
          await this.rap.connect();
        } catch (err2) {
          this.sendErrorResponse(reqSeq, 'launch', `ROS started but cannot connect: ${err2}`);
          return;
        }
      } else {
        this.sendErrorResponse(reqSeq, 'launch', `Cannot connect to ROS at ws://${rosHost}:${rosPort}. Start ROS first (Ctrl+Shift+P → Reagent: Start ROS).`);
        return;
      }
    }

    // Listen for Stopped events from ROS → DAP + debug panel + inline values
    this.disposables.push(this.rap.on('Stopped', (msg) => {
      this.paused = true;
      this.stoppedReason = String(msg.payload?.reason || 'breakpoint');
      this.stoppedDetail = (msg.payload || {}) as Record<string, unknown>;

      // Update scatter branch tracking from ROS payload
      const branchIdx = this.stoppedDetail.scatterBranchIndex;
      if (typeof branchIdx === 'number') {
        this.scatterBranchIndex = branchIdx;
      }

      // Auto-pop protocol stack when ROS signals we've returned to a parent protocol
      if (this.stoppedDetail.returnedFromChild && this.protocolStack.length > 0) {
        this.protocolStack.pop();
      }

      this.sendEvent('stopped', {
        reason: 'breakpoint',
        threadId: THREAD_ID,
        description: this.stoppedReason,
        allThreadsStopped: true,
      });
      this.pushStateToSinks();
    }));

    // Listen for RunCompleted
    this.disposables.push(this.rap.on('RunCompleted', () => {
      this.sendEvent('terminated', {});
    }));

    // Listen for TraceEvents → output channel + debug panel
    this.disposables.push(this.rap.on('TraceEvent', (msg) => {
      const p = (msg.payload || {}) as Record<string, unknown>;
      const kind = (p.kind || 'trace') as string;
      const agent = (p.agentName || '') as string;
      this.sendEvent('output', {
        category: 'console',
        output: `[${kind}] ${agent}: ${JSON.stringify(p)}\n`,
      });
      this.sinks?.debugPanel.addTrace({
        kind,
        agentName: agent || undefined,
        instanceId: p.instanceId as string | undefined,
        timestamp: Date.now(),
        detail: p,
      });
    }));

    // Read .rg source
    let rgSource: string;
    try {
      rgSource = fs.readFileSync(this.rgFilePath, 'utf-8');
    } catch (err) {
      this.sendErrorResponse(reqSeq, 'launch', `Cannot read ${this.rgFilePath}: ${err}`);
      return;
    }

    // Compile (field name must match ROS expectation: rgSource, fileName)
    const compileResp = await this.rap.request('Compile', { rgSource, fileName: path.basename(this.rgFilePath) }, 'CompileSuccess', 15000);
    if (compileResp.rap === 'CompileError') {
      this.sendErrorResponse(reqSeq, 'launch', `Compile error: ${JSON.stringify(compileResp.payload)}`);
      return;
    }
    this.sessionId = compileResp.sessionId || (compileResp.payload?.sessionId as string) || 'default';
    this.sourceMap = (compileResp.payload?.sourceMap as SourceMapEntry[]) || [];

    // Start in debug mode
    this.rap.send({
      rap: 'RunStart',
      sessionId: this.sessionId,
      payload: { sessionId: this.sessionId, mode: 'debug' },
    });

    ReagentDebugSession.activeSession = this;
    this.sendResponse(reqSeq, 'launch');
  }

  private async handleSetBreakpoints(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const source = args.source as { path?: string } | undefined;
    const bpArgs = args.breakpoints as Array<{ line: number }> | undefined;
    const breakpoints: Array<{ verified: boolean; line: number; message?: string }> = [];

    if (this.rap?.connected && bpArgs && bpArgs.length > 0) {
      const locations = bpArgs.map(bp => ({
        type: 'sourceLine' as const,
        file: source?.path || this.rgFilePath,
        line: bp.line,
      }));

      this.rap.send({
        rap: 'SetBreakpointsRequest',
        sessionId: this.sessionId || 'default',
        payload: {
          sessionId: this.sessionId || 'default',
          breakpoints: locations,
        },
      });

      for (const bp of bpArgs) {
        const mapped = this.sourceMap.find(e => e.line === bp.line);
        breakpoints.push({
          verified: !!mapped,
          line: bp.line,
          message: mapped ? `→ ${mapped.stateId} (${mapped.protocolName}.${mapped.role})` : 'No IR state at this line',
        });
      }
    } else if (bpArgs) {
      for (const bp of bpArgs) {
        breakpoints.push({ verified: false, line: bp.line });
      }
    }

    this.sendResponse(reqSeq, 'setBreakpoints', { breakpoints });
  }

  private handleStackTrace(reqSeq: number): void {
    const frames: Array<{
      id: number;
      name: string;
      source: { name: string; path: string };
      line: number;
      column: number;
    }> = [];

    if (this.paused) {
      const stateId = this.stoppedDetail.stateId as string | undefined;
      const stateKind = this.stoppedDetail.stateKind as string | undefined;
      const agentName = this.stoppedDetail.agentName as string | undefined;
      const mapped = stateId ? this.sourceMap.find(e => e.stateId === stateId) : undefined;

      const protocolName = this.stoppedDetail.protocolName as string | undefined;
      const role = this.stoppedDetail.role as string | undefined;
      const prefix = protocolName && role
        ? `${protocolName}.${role}`
        : (agentName || 'agent');
      let frameName = `${prefix} @ ${stateKind || 'state'} (${stateId || '?'})`;

      if (this.scatterBranchIndex !== null) {
        frameName += ` [branch ${this.scatterBranchIndex}]`;
      }

      frames.push({
        id: 1,
        name: frameName,
        source: {
          name: path.basename(this.rgFilePath),
          path: this.rgFilePath,
        },
        line: mapped?.line || 1,
        column: mapped?.column || 0,
      });

      for (let i = this.protocolStack.length - 1; i >= 0; i--) {
        const parent = this.protocolStack[i];
        const parentMapped = this.sourceMap.find(e => e.stateId === parent.stateId);
        frames.push({
          id: frames.length + 1,
          name: `${parent.protocolName}.${parent.role} @ ${parent.stateId}`,
          source: {
            name: path.basename(this.rgFilePath),
            path: this.rgFilePath,
          },
          line: parentMapped?.line || 1,
          column: parentMapped?.column || 0,
        });
      }
    }

    this.sendResponse(reqSeq, 'stackTrace', {
      stackFrames: frames,
      totalFrames: frames.length,
    });
  }

  private handleScopes(reqSeq: number, args: Record<string, unknown>): void {
    this.sendResponse(reqSeq, 'scopes', {
      scopes: [
        { name: '$ctx', variablesReference: 100, expensive: false },
        { name: '$self', variablesReference: 200, expensive: false },
        { name: '$flow', variablesReference: 400, expensive: false },
        { name: 'Held Messages', variablesReference: 300, expensive: false },
      ],
    });
  }

  private async handleVariables(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const ref = args.variablesReference as number;
    const variables: Array<{ name: string; value: string; variablesReference: number }> = [];

    if (this.rap?.connected && this.paused) {
      try {
        const agentName = (this.stoppedDetail.agentName || '') as string;
        this.rap.send({
          rap: 'GetState',
          sessionId: this.sessionId || 'default',
          payload: { sessionId: this.sessionId || 'default', agentName },
        });

        const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
          const disposable = this.rap!.on('StateSnapshot', (msg) => {
            clearTimeout(timer);
            disposable.dispose();
            resolve((msg.payload || {}) as Record<string, unknown>);
          });
        });

        if (ref === 100) {
          const ctx = (snapshot.ctx || {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(ctx)) {
            variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
          }
        } else if (ref === 200) {
          const self = (snapshot.self || {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(self)) {
            variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
          }
        } else if (ref === 400) {
          const flow = (snapshot.flow || {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(flow)) {
            variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
          }
        } else if (ref === 300) {
          const held = (snapshot.heldMessages || []) as Array<{ messageName?: string; from?: string; to?: string }>;
          for (let i = 0; i < held.length; i++) {
            const h = held[i];
            variables.push({
              name: `[${i}]`,
              value: `${h.messageName || '?'} (${h.from} → ${h.to})`,
              variablesReference: 0,
            });
          }
        }
      } catch {
        variables.push({ name: '(error)', value: 'Failed to fetch state', variablesReference: 0 });
      }
    }

    this.sendResponse(reqSeq, 'variables', { variables });
  }

  private async handleContinue(reqSeq: number): Promise<void> {
    if (this.rap?.connected) {
      this.rap.send({
        rap: 'DebugCommand',
        sessionId: this.sessionId || 'default',
        payload: { sessionId: this.sessionId || 'default', command: 'continue' },
      });
    }
    this.paused = false;
    this.sendResponse(reqSeq, 'continue', { allThreadsContinued: true });
  }

  private sendDebugCommand(command: string, extra?: Record<string, unknown>): void {
    if (!this.rap?.connected) return;
    this.rap.send({
      rap: 'DebugCommand',
      sessionId: this.sessionId || 'default',
      payload: { sessionId: this.sessionId || 'default', command, ...extra },
    });
  }

  /**
   * Step Over (F10 / "next"):
   * - At scatter: execute all branches to join, stop after join.
   * - At invoke/spawn: execute child protocol to completion, stop after return.
   * - Otherwise: advance one IR state.
   */
  private async handleStepOver(reqSeq: number): Promise<void> {
    const kind = this.stoppedDetail.stateKind as string | undefined;

    if (kind === 'scatter' || kind === 'fork') {
      this.scatterBranchIndex = null;
      this.sendDebugCommand('stepOverScatter');
    } else if (kind === 'invoke' || kind === 'spawn') {
      this.sendDebugCommand('stepOverInvoke');
    } else {
      this.sendDebugCommand('stepState');
    }

    this.paused = false;
    this.sendResponse(reqSeq, 'next');
  }

  /**
   * Step In (F11 / "stepIn"):
   * - At scatter: enter branch 0, stepping one state at a time within that branch.
   * - At invoke/spawn: push current frame, enter child protocol.
   * - Otherwise: same as step-over (advance one state).
   */
  private async handleStepIn(reqSeq: number): Promise<void> {
    const kind = this.stoppedDetail.stateKind as string | undefined;

    if (kind === 'scatter' || kind === 'fork') {
      this.scatterBranchIndex = 0;
      this.sendDebugCommand('stepIntoScatter', { branchIndex: 0 });
    } else if (kind === 'invoke' || kind === 'spawn') {
      const stateId = this.stoppedDetail.stateId as string | undefined;
      const protocolName = this.stoppedDetail.protocolName as string | undefined;
      const role = this.stoppedDetail.role as string | undefined;

      if (stateId && protocolName && role) {
        this.protocolStack.push({
          protocolName,
          role,
          stateId,
          sessionId: this.sessionId || 'default',
        });
      }
      this.sendDebugCommand('stepIntoInvoke');
    } else {
      this.sendDebugCommand('stepState');
    }

    this.paused = false;
    this.sendResponse(reqSeq, 'stepIn');
  }

  /**
   * Step Out (Shift+F11 / "stepOut"):
   * - Inside scatter branch: jump to scatter join, resume parent flow.
   * - Inside invoked/spawned child: pop frame, return to parent protocol.
   * - Otherwise: run to end of current scope / protocol.
   */
  private async handleStepOut(reqSeq: number): Promise<void> {
    if (this.scatterBranchIndex !== null) {
      this.scatterBranchIndex = null;
      this.sendDebugCommand('stepOutScatter');
    } else if (this.protocolStack.length > 0) {
      this.protocolStack.pop();
      this.sendDebugCommand('stepOutInvoke');
    } else {
      this.sendDebugCommand('stepOver');
    }

    this.paused = false;
    this.sendResponse(reqSeq, 'stepOut');
  }

  private handleDisconnect(reqSeq: number): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.rap?.close();
    this.rap = null;
    if (ReagentDebugSession.activeSession === this) {
      ReagentDebugSession.activeSession = null;
    }
    this.sendResponse(reqSeq, 'disconnect');
  }

  private pushStateToSinks(): void {
    if (!this.sinks || !this.rap?.connected) return;

    const stateId = this.stoppedDetail.stateId as string | undefined;
    const mapped = stateId ? this.sourceMap.find(e => e.stateId === stateId) : undefined;
    const agentName = (this.stoppedDetail.agentName || 'agent') as string;

    this.rap.send({
      rap: 'GetState',
      sessionId: this.sessionId || 'default',
      payload: { sessionId: this.sessionId || 'default', agentName },
    });

    const disposable = this.rap.on('StateSnapshot', (snapMsg) => {
      disposable.dispose();
      const snap = (snapMsg.payload || {}) as Record<string, unknown>;
      const ctx = (snap.ctx || {}) as Record<string, unknown>;
      const self = (snap.self || {}) as Record<string, unknown>;
      const flow = (snap.flow || {}) as Record<string, unknown>;
      const held = (snap.heldMessages || []) as Array<{ messageName: string; from: string; to: string }>;

      this.sinks!.debugPanel.updateAgentState(agentName, { $ctx: ctx, $self: self, $flow: flow });
      this.sinks!.debugPanel.updateHeldMessages(held);

      if (mapped) {
        this.sinks!.inlineValues.showValues(this.rgFilePath, mapped.line, ctx, self, flow);
      }
    });

    setTimeout(() => disposable.dispose(), 3000);
  }

  private sendResponse(reqSeq: number, command: string, body?: Record<string, unknown>): void {
    this.sendMessage.fire({
      type: 'response',
      request_seq: reqSeq,
      command,
      seq: ++this.seq,
      success: true,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private sendErrorResponse(reqSeq: number, command: string, message: string): void {
    this.sendMessage.fire({
      type: 'response',
      request_seq: reqSeq,
      command,
      seq: ++this.seq,
      success: false,
      message,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body: Record<string, unknown>): void {
    this.sendMessage.fire({
      type: 'event',
      event,
      seq: ++this.seq,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.rap?.close();
    if (ReagentDebugSession.activeSession === this) {
      ReagentDebugSession.activeSession = null;
    }
    this.sendMessage.dispose();
  }
}

/**
 * Factory that creates inline ReagentDebugSession instances for each debug session.
 */
export class ReagentDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly sinks?: DebugSinks, private readonly rosManager?: RosManager) {}

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new ReagentDebugSession(this.sinks, this.rosManager));
  }
}
