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
  /** When set, the session attaches to an existing cluster debug instead of compiling/running. */
  clusterSessionId?: string;
  /** Pre-connected RAP client to reuse (set programmatically, not from JSON). */
  _rapClient?: RapClient;
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
  private isClusterAttach = false;

  /** Pending cluster-attach RAP client, set before startDebugging(). */
  static pendingClusterRap: RapClient | null = null;
  /** Pending source map for cluster-attach, set before startDebugging(). */
  static pendingSourceMap: SourceMapEntry[] | null = null;
  /** Cached Stopped payload from diagram panel (set when Stopped arrives before DAP is ready). */
  static pendingStoppedPayload: Record<string, unknown> | null = null;

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

  private _requestQueue: Promise<void> = Promise.resolve();

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as { type: string; command?: string; seq: number; arguments?: Record<string, unknown> };
    if (msg.type === 'request') {
      this._requestQueue = this._requestQueue
        .then(() => this.handleRequest(msg.command!, msg.seq, msg.arguments || {}))
        .catch(() => { /* prevent chain breakage */ });
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
          if ((args as any).clusterSessionId) {
            await this.handleClusterAttach(reqSeq, args as unknown as LaunchConfig);
          } else {
            await this.handleLaunch(reqSeq, args as unknown as LaunchConfig);
          }
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
          this.sendDebugCommand('stepState');
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
      const payload = (msg.payload || {}) as Record<string, unknown>;
      const sid = payload.sessionId as string | undefined;
      if (sid && this.sessionId && sid !== this.sessionId) return;

      this.paused = true;
      this.stoppedReason = String(payload.reason || 'step');
      this.stoppedDetail = payload;

      const branchIdx = this.stoppedDetail.scatterBranchIndex;
      if (typeof branchIdx === 'number') {
        this.scatterBranchIndex = branchIdx;
      }

      if (this.stoppedDetail.returnedFromChild && this.protocolStack.length > 0) {
        this.protocolStack.pop();
      }

      const dapReason = this.stoppedReason === 'breakpoint' ? 'breakpoint' : 'step';
      this.sendEvent('stopped', {
        reason: dapReason,
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

  /**
   * Attach to an existing cluster debug session — reuses the cluster's RAP
   * connection and source map without compiling/running.
   */
  private async handleClusterAttach(reqSeq: number, config: LaunchConfig): Promise<void> {
    this.rgFilePath = config.rgFile || '';
    this.sessionId = config.clusterSessionId!;
    this.isClusterAttach = true;

    const pendingRap = ReagentDebugSession.pendingClusterRap;
    ReagentDebugSession.pendingClusterRap = null;

    if (pendingRap && pendingRap.connected) {
      this.rap = pendingRap;
    } else {
      const rosHost = config.rosHost || '127.0.0.1';
      const rosPort = config.rosPort || 18789;
      this.rap = new RapClient(`ws://${rosHost}:${rosPort}`);
      try {
        await this.rap.connect();
      } catch {
        this.sendErrorResponse(reqSeq, 'launch', 'Cannot connect to ROS for cluster attach');
        return;
      }
    }

    // Use pre-computed source map from the diagram panel
    const pendingMap = ReagentDebugSession.pendingSourceMap;
    ReagentDebugSession.pendingSourceMap = null;
    if (pendingMap && pendingMap.length > 0) {
      this.sourceMap = pendingMap;
    }

    // Listen for source map updates after recompile/redeploy
    this.disposables.push(this.rap.on('SourceMapUpdated', (msg) => {
      const payload = (msg.payload || {}) as Record<string, unknown>;
      const sm = payload.sourceMap as { entries?: SourceMapEntry[] } | undefined;
      if (sm?.entries && sm.entries.length > 0) {
        this.sourceMap = sm.entries;
      }
    }));

    // Listen for Stopped events from cluster
    this.disposables.push(this.rap.on('Stopped', (msg) => {
      const payload = (msg.payload || {}) as Record<string, unknown>;
      const sid = payload.sessionId as string | undefined;
      if (sid && sid !== this.sessionId) return;

      this.paused = true;
      this.stoppedReason = String(payload.reason || 'step');
      this.stoppedDetail = payload;

      const branchIdx = payload.scatterBranchIndex;
      if (typeof branchIdx === 'number') {
        this.scatterBranchIndex = branchIdx;
      }
      if (payload.returnedFromChild && this.protocolStack.length > 0) {
        this.protocolStack.pop();
      }

      const dapReason = this.stoppedReason === 'breakpoint' ? 'breakpoint' : 'step';
      this.sendEvent('stopped', {
        reason: dapReason,
        threadId: THREAD_ID,
        description: this.stoppedReason,
        allThreadsStopped: true,
      });
      this.pushStateToSinks();
    }));

    // Listen for TraceEvent with ProtocolCompleted to auto-terminate
    this.disposables.push(this.rap.on('TraceEvent', (msg) => {
      const p = (msg.payload || {}) as Record<string, unknown>;
      const kind = (p.kind || '') as string;
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

      if (kind === 'ProtocolCompleted' || kind === 'ProtocolFailed') {
        this.sendEvent('terminated', {});
      }
    }));

    ReagentDebugSession.activeSession = this;
    this.sendResponse(reqSeq, 'launch');

    // Replay any Stopped payload that arrived before the DAP adapter was ready.
    // Defer slightly so VSCode processes the launch response first.
    const pending = ReagentDebugSession.pendingStoppedPayload;
    ReagentDebugSession.pendingStoppedPayload = null;
    if (pending) {
      setTimeout(() => {
        if (this.paused) return;
        const sid = pending.sessionId as string | undefined;
        if (!sid || sid === this.sessionId) {
          this.paused = true;
          this.stoppedReason = String(pending.reason || 'step');
          this.stoppedDetail = pending;
          const dapReason = this.stoppedReason === 'breakpoint' ? 'breakpoint' : 'step';
          this.sendEvent('stopped', {
            reason: dapReason,
            threadId: THREAD_ID,
            allThreadsStopped: true,
          });
          this.pushStateToSinks();
        }
      }, 100);
    }
  }

  private async handleSetBreakpoints(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const source = args.source as { path?: string } | undefined;
    const bpArgs = args.breakpoints as Array<{ line: number }> | undefined;
    const breakpoints: Array<{ verified: boolean; line: number; message?: string }> = [];

    // Fallback: if source map is empty, try reading from compiled output
    if (this.sourceMap.length === 0 && this.rgFilePath) {
      this.sourceMap = tryReadSourceMapFromDisk(this.rgFilePath);
    }

    if (this.rap?.connected && bpArgs && bpArgs.length > 0) {
      if (this.isClusterAttach) {
        const stateIds: string[] = [];
        const bpFile = source?.path || this.rgFilePath;
        for (const bp of bpArgs) {
          const mapped = findNearestSourceMapEntry(this.sourceMap, bp.line, bpFile);
          if (mapped) {
            stateIds.push(mapped.stateId);
            const adjusted = mapped.line !== bp.line ? ` (snapped from line ${bp.line})` : '';
            breakpoints.push({
              verified: true,
              line: mapped.line,
              message: `→ ${mapped.stateId}${adjusted}`,
            });
          } else {
            breakpoints.push({ verified: false, line: bp.line, message: 'No IR state near this line' });
          }
        }
        if (stateIds.length > 0) {
          this.rap.send({
            rap: 'DebugCommand',
            payload: {
              sessionId: this.sessionId || 'default',
              command: 'setBreakpoints',
              breakpoints: stateIds,
            },
          });
        }
      } else {
        const bpFile = source?.path || this.rgFilePath;
        const resolvedLocations: Array<{ type: 'sourceLine'; file: string; line: number }> = [];
        for (const bp of bpArgs) {
          const mapped = findNearestSourceMapEntry(this.sourceMap, bp.line, bpFile);
          if (mapped) {
            resolvedLocations.push({ type: 'sourceLine', file: bpFile, line: mapped.line });
            const adjusted = mapped.line !== bp.line ? ` (snapped from line ${bp.line})` : '';
            breakpoints.push({
              verified: true,
              line: mapped.line,
              message: `→ ${mapped.stateId}${adjusted}`,
            });
          } else {
            resolvedLocations.push({ type: 'sourceLine', file: bpFile, line: bp.line });
            breakpoints.push({ verified: false, line: bp.line, message: 'No IR state near this line' });
          }
        }

        this.rap.send({
          rap: 'SetBreakpointsRequest',
          sessionId: this.sessionId || 'default',
          payload: {
            sessionId: this.sessionId || 'default',
            breakpoints: resolvedLocations,
          },
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
        { name: 'Instance', variablesReference: 500, expensive: false },
        { name: 'Held Messages', variablesReference: 300, expensive: false },
      ],
    });
  }

  private async handleVariables(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const ref = args.variablesReference as number;
    const variables: Array<{ name: string; value: string; variablesReference: number }> = [];

    if (this.paused) {
      if (this.isClusterAttach) {
        // For cluster-attach, use the ctx/self from the Stopped payload
        this.extractVariablesFromStoppedDetail(ref, variables);
      } else if (this.rap?.connected) {
        try {
          const agentName = (this.stoppedDetail.agentName || '') as string;
          const requestId = `var-${++this._stateReqSeq}`;
          this.rap.send({
            rap: 'GetState',
            id: requestId,
            sessionId: this.sessionId || 'default',
            payload: { sessionId: this.sessionId || 'default', agentName, requestId },
          });

          const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
            const disposable = this.rap!.on('StateSnapshot', (msg) => {
              const p = (msg.payload || {}) as Record<string, unknown>;
              if (p.requestId && p.requestId !== requestId) return;
              clearTimeout(timer);
              disposable.dispose();
              resolve(p);
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
          } else if (ref === 500) {
            const fields: Array<[string, string]> = [
              ['instanceId', String(this.stoppedDetail.instanceId ?? '')],
              ['protocolName', String(this.stoppedDetail.protocolName ?? '')],
              ['roleName', String(this.stoppedDetail.roleName ?? '')],
              ['agentName', String(this.stoppedDetail.agentName ?? '')],
              ['stateId', String(this.stoppedDetail.stateId ?? '')],
              ['stateKind', String(this.stoppedDetail.stateKind ?? '')],
            ];
            for (const [name, value] of fields) {
              if (value) variables.push({ name, value: JSON.stringify(value), variablesReference: 0 });
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
    }

    this.sendResponse(reqSeq, 'variables', { variables });
  }

  private extractVariablesFromStoppedDetail(
    ref: number,
    variables: Array<{ name: string; value: string; variablesReference: number }>,
  ): void {
    if (ref === 100) {
      const ctx = (this.stoppedDetail.ctx || {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(ctx)) {
        variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
      }
    } else if (ref === 200) {
      const self = (this.stoppedDetail.self || {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(self)) {
        variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
      }
    } else if (ref === 500) {
      const fields: Array<[string, string]> = [
        ['instanceId', String(this.stoppedDetail.instanceId ?? '')],
        ['protocolName', String(this.stoppedDetail.protocolName ?? '')],
        ['roleName', String(this.stoppedDetail.roleName ?? '')],
        ['agentName', String(this.stoppedDetail.agentName ?? '')],
        ['stateId', String(this.stoppedDetail.stateId ?? '')],
        ['stateKind', String(this.stoppedDetail.stateKind ?? '')],
      ];
      for (const [name, value] of fields) {
        if (value) variables.push({ name, value: JSON.stringify(value), variablesReference: 0 });
      }
    }
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
    if (this.isClusterAttach && this.rap?.connected && this.sessionId) {
      this.rap.send({
        rap: 'DebugCommand',
        payload: { sessionId: this.sessionId, command: 'stop' },
      });
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    if (!this.isClusterAttach) {
      this.rap?.close();
    }
    this.rap = null;
    if (ReagentDebugSession.activeSession === this) {
      ReagentDebugSession.activeSession = null;
    }
    this.sendResponse(reqSeq, 'disconnect');
  }

  private _stateReqSeq = 0;

  private pushStateToSinks(): void {
    if (!this.sinks || !this.rap?.connected) return;

    const stateId = this.stoppedDetail.stateId as string | undefined;
    const mapped = stateId ? this.sourceMap.find(e => e.stateId === stateId) : undefined;
    const agentName = (this.stoppedDetail.agentName || 'agent') as string;

    this.sinks.debugPanel.updateDebugState(true, stateId ?? null);

    const requestId = `sink-${++this._stateReqSeq}`;
    this.rap.send({
      rap: 'GetState',
      id: requestId,
      sessionId: this.sessionId || 'default',
      payload: { sessionId: this.sessionId || 'default', agentName, requestId },
    });

    const disposable = this.rap.on('StateSnapshot', (snapMsg) => {
      const snap = (snapMsg.payload || {}) as Record<string, unknown>;
      if (snap.requestId && snap.requestId !== requestId) return;
      disposable.dispose();
      const ctx = (snap.ctx || {}) as Record<string, unknown>;
      const self = (snap.self || {}) as Record<string, unknown>;
      const held = (snap.heldMessages || []) as Array<{ messageName: string; from: string; to: string }>;

      this.sinks!.debugPanel.updateAgentState(agentName, { $ctx: ctx, $self: self });
      this.sinks!.debugPanel.updateHeldMessages(held);

      if (mapped) {
        this.sinks!.inlineValues.showValues(this.rgFilePath, mapped.line, ctx, self);
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
    if (!this.isClusterAttach) {
      this.rap?.close();
    }
    this.rap = null;
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

const NEAREST_LINE_RANGE = 5;

/**
 * Find an exact or nearest source map entry for a given line.
 * Searches within ±NEAREST_LINE_RANGE lines, preferring exact match,
 * then closest line after, then closest line before.
 */
function findNearestSourceMapEntry(
  sourceMap: SourceMapEntry[],
  line: number,
  file?: string,
): SourceMapEntry | undefined {
  const candidates = file
    ? sourceMap.filter(e => e.file === file || e.file === '' || !e.file)
    : sourceMap;

  const exact = candidates.find(e => e.line === line);
  if (exact) return exact;

  let best: SourceMapEntry | undefined;
  let bestDist = NEAREST_LINE_RANGE + 1;

  for (const e of candidates) {
    const dist = Math.abs(e.line - line);
    if (dist > NEAREST_LINE_RANGE) continue;
    if (dist < bestDist || (dist === bestDist && e.line > line)) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Fallback: walk up from the .rg file to find out/source-map.json in the project.
 */
function tryReadSourceMapFromDisk(rgFilePath: string): SourceMapEntry[] {
  try {
    let dir = path.dirname(rgFilePath);
    for (let i = 0; i < 5; i++) {
      const smPath = path.join(dir, 'out', 'source-map.json');
      if (fs.existsSync(smPath)) {
        const raw = JSON.parse(fs.readFileSync(smPath, 'utf-8'));
        return (raw.entries ?? []) as SourceMapEntry[];
      }
      const reagentJson = path.join(dir, 'reagent.json');
      if (fs.existsSync(reagentJson)) {
        break;
      }
      dir = path.dirname(dir);
    }
  } catch { /* non-fatal */ }
  return [];
}
