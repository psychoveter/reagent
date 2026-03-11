import * as vscode from 'vscode';
import { RapClient } from './rapClient';
import { ReagentDebugPanelProvider } from './debugPanelProvider';
import { ReagentInlineValues } from './inlineValues';
import * as fs from 'fs';
import * as path from 'path';
import { logDebugProtocol } from './debugLog';

const THREAD_ID = 1;
const SPAWN_THREAD_BASE = 100;

// Variable scope reference ranges
const SCOPE_CTX = 100;
const SCOPE_SELF = 200;
const SCOPE_HELD = 300;
const SCOPE_INSTANCE = 500;
const SCOPE_RESOLVE = 1000;
const SCOPE_RESOLVE_CANDIDATES = 1001;
const SCOPE_RESOLVE_SELECTED = 1002;
const SCOPE_PARTICIPANTS = 2000;
const SCOPE_REGISTRY = 3000;

interface LaunchConfig extends vscode.DebugConfiguration {
  rgFile: string;
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

  private nextBreakpointId = 1;
  private breakpointMap = new Map<number, { id: number; line: number; stateId?: string; verified: boolean; source?: string }>();
  private pendingClusterBreakpointStateIds: string[] = [];
  private activeThreads = new Map<number, { name: string; instanceId?: string }>();

  /** T.15: Next thread ID for spawned agents. */
  private nextSpawnThreadId = SPAWN_THREAD_BASE;
  /** T.15: Map from spawned agent name to DAP thread ID. */
  private spawnedAgentThreads = new Map<string, number>();

  /** T.13: Resolve-level stopped data (role, candidates, selected, pipelineSummary). */
  private resolveDetail: {
    role: string;
    candidates: string[];
    selected: string[];
    pipelineSummary: string;
  } | null = null;

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

  constructor(private readonly sinks?: DebugSinks) {}

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

        case 'threads': {
          const threads = this.activeThreads.size > 0
            ? Array.from(this.activeThreads.entries()).map(([id, t]) => ({ id, name: t.name }))
            : [{ id: THREAD_ID, name: 'Reagent Protocol' }];
          this.sendResponse(reqSeq, command, { threads });
          break;
        }

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
    this.rgFilePath = config.rgFile;
    this.sendErrorResponse(
      reqSeq,
      'launch',
      'Direct local debug via the removed server-backed path is no longer available. Use cluster debug from the diagram/cluster tooling.',
    );
  }

  /**
   * Attach to an existing cluster debug session — reuses the cluster's RAP
   * connection and source map without compiling/running.
   */
  private async handleClusterAttach(reqSeq: number, config: LaunchConfig): Promise<void> {
    this.rgFilePath = config.rgFile || '';
    this.sessionId = config.clusterSessionId!;
    this.isClusterAttach = true;
    logDebugProtocol('dap.handleClusterAttach.begin', {
      sessionId: this.sessionId,
      rgFilePath: this.rgFilePath,
    });

    const pendingRap = ReagentDebugSession.pendingClusterRap;
    ReagentDebugSession.pendingClusterRap = null;

    if (pendingRap && pendingRap.connected) {
      this.rap = pendingRap;
    } else {
      this.rap = new RapClient('cluster://default');
      try {
        await this.rap.connect();
      } catch {
        this.sendErrorResponse(reqSeq, 'launch', 'Cannot connect to cluster control plane for cluster attach');
        return;
      }
    }

    // Use pre-computed source map from the diagram panel
    const pendingMap = ReagentDebugSession.pendingSourceMap;
    ReagentDebugSession.pendingSourceMap = null;
    if (pendingMap && pendingMap.length > 0) {
      this.sourceMap = pendingMap;
    }
    logDebugProtocol('dap.handleClusterAttach.sourceMapReady', {
      sessionId: this.sessionId,
      sourceMapEntries: this.sourceMap.length,
      pendingBreakpointStateIds: this.pendingClusterBreakpointStateIds,
    });

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
      logDebugProtocol('dap.event.Stopped', {
        sessionId: this.sessionId,
        stateId: payload.stateId,
        stateKind: payload.stateKind,
        reason: payload.reason,
        roleName: payload.roleName,
      });

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

      this.applyStoppedEvent(payload);
    }));

    // Listen for TraceEvent with ProtocolCompleted to auto-terminate + spawn threads
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
      this.handleSpawnTraceEvent(kind, p);

      if (kind === 'ProtocolCompleted' || kind === 'ProtocolFailed') {
        this.sendEvent('terminated', {});
      }
    }));

    ReagentDebugSession.activeSession = this;
    this.flushPendingClusterBreakpoints();
    this.addThread(THREAD_ID, 'Reagent Protocol');
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

  /**
   * Shared logic for processing a Stopped payload: detects resolve-level stops,
   * stores resolve detail, and fires the appropriate DAP stopped event.
   */
  private applyStoppedEvent(payload: Record<string, unknown>): void {
    const level = payload.level as string | undefined;
    logDebugProtocol('dap.applyStoppedEvent', {
      sessionId: this.sessionId,
      level,
      reason: this.stoppedReason,
      stateId: payload.stateId,
      stateKind: payload.stateKind,
      roleName: payload.roleName,
    });

    if (level === 'resolve') {
      this.resolveDetail = {
        role: String(payload.role || ''),
        candidates: (payload.candidates as string[]) || [],
        selected: (payload.selected as string[]) || [],
        pipelineSummary: String(payload.pipelineSummary || ''),
      };
      const desc = `Resolve: ${this.resolveDetail.role} — ${this.resolveDetail.selected.length}/${this.resolveDetail.candidates.length} selected`;
      this.sendEvent('stopped', {
        reason: 'resolve',
        threadId: THREAD_ID,
        description: desc,
        allThreadsStopped: true,
      });
    } else {
      this.resolveDetail = null;
      const dapReason = this.stoppedReason === 'breakpoint' ? 'breakpoint' : 'step';
      this.sendEvent('stopped', {
        reason: dapReason,
        threadId: THREAD_ID,
        description: this.stoppedReason,
        allThreadsStopped: true,
      });
    }

    this.pushStateToSinks();
  }

  private async handleSetBreakpoints(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const source = args.source as { path?: string } | undefined;
    const bpArgs = args.breakpoints as Array<{ line: number }> | undefined;
    const bpFile = source?.path || this.rgFilePath;
    const breakpoints: Array<{ id: number; verified: boolean; line: number; message?: string }> = [];
    const mappedStateIds: string[] = [];

    // Remove previous breakpoints for this source file
    for (const [id, bp] of this.breakpointMap) {
      if (bp.source === bpFile) this.breakpointMap.delete(id);
    }

    // Fallback: if source map is empty, try reading from compiled output.
    // This must work even before launch/attach assigns rgFilePath, because
    // VSCode can send setBreakpoints before launch in the DAP lifecycle.
    if (this.sourceMap.length === 0) {
      const fallbackPath = bpFile || this.rgFilePath;
      if (fallbackPath) {
        this.sourceMap = tryReadSourceMapFromDisk(fallbackPath);
      }
    }
    logDebugProtocol('dap.handleSetBreakpoints.begin', {
      sessionId: this.sessionId,
      isClusterAttach: this.isClusterAttach,
      source: bpFile,
      requestedLines: (bpArgs ?? []).map(bp => bp.line),
      sourceMapEntries: this.sourceMap.length,
    });

    if (this.rap?.connected && bpArgs && bpArgs.length > 0) {
      if (this.isClusterAttach) {
        const stateIds: string[] = [];
        for (const bp of bpArgs) {
          const bpId = this.nextBreakpointId++;
          const mapped = findNearestSourceMapEntry(this.sourceMap, bp.line, bpFile);
          if (mapped) {
            stateIds.push(mapped.stateId);
            mappedStateIds.push(mapped.stateId);
            const adjusted = mapped.line !== bp.line ? ` (snapped from line ${bp.line})` : '';
            breakpoints.push({
              id: bpId,
              verified: true,
              line: mapped.line,
              message: `→ ${mapped.stateId}${adjusted}`,
            });
            this.breakpointMap.set(bpId, { id: bpId, line: mapped.line, stateId: mapped.stateId, verified: true, source: bpFile });
          } else {
            breakpoints.push({ id: bpId, verified: false, line: bp.line, message: 'No IR state near this line' });
            this.breakpointMap.set(bpId, { id: bpId, line: bp.line, verified: false, source: bpFile });
          }
        }
        this.pendingClusterBreakpointStateIds = stateIds;
        logDebugProtocol('dap.handleSetBreakpoints.clusterMapped', {
          sessionId: this.sessionId,
          source: bpFile,
          mappedStateIds: stateIds,
          dapBreakpoints: breakpoints,
        });
        this.flushPendingClusterBreakpoints();
      } else {
        const resolvedLocations: Array<{ type: 'sourceLine'; file: string; line: number }> = [];
        for (const bp of bpArgs) {
          const bpId = this.nextBreakpointId++;
          const mapped = findNearestSourceMapEntry(this.sourceMap, bp.line, bpFile);
          if (mapped) {
            mappedStateIds.push(mapped.stateId);
            resolvedLocations.push({ type: 'sourceLine', file: bpFile, line: mapped.line });
            const adjusted = mapped.line !== bp.line ? ` (snapped from line ${bp.line})` : '';
            breakpoints.push({
              id: bpId,
              verified: true,
              line: mapped.line,
              message: `→ ${mapped.stateId}${adjusted}`,
            });
            this.breakpointMap.set(bpId, { id: bpId, line: mapped.line, stateId: mapped.stateId, verified: true, source: bpFile });
          } else {
            resolvedLocations.push({ type: 'sourceLine', file: bpFile, line: bp.line });
            breakpoints.push({ id: bpId, verified: false, line: bp.line, message: 'No IR state near this line' });
            this.breakpointMap.set(bpId, { id: bpId, line: bp.line, verified: false, source: bpFile });
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
        const bpId = this.nextBreakpointId++;
        const mapped = findNearestSourceMapEntry(this.sourceMap, bp.line, bpFile);
        if (mapped) {
          mappedStateIds.push(mapped.stateId);
          breakpoints.push({ id: bpId, verified: true, line: mapped.line, message: `→ ${mapped.stateId}` });
          this.breakpointMap.set(bpId, { id: bpId, line: mapped.line, stateId: mapped.stateId, verified: true, source: bpFile });
        } else {
          breakpoints.push({ id: bpId, verified: false, line: bp.line });
          this.breakpointMap.set(bpId, { id: bpId, line: bp.line, verified: false, source: bpFile });
        }
      }
    }

    if (mappedStateIds.length > 0) {
      this.pendingClusterBreakpointStateIds = mappedStateIds;
    }
    logDebugProtocol('dap.handleSetBreakpoints.end', {
      sessionId: this.sessionId,
      mappedStateIds: mappedStateIds,
      pendingClusterBreakpointStateIds: this.pendingClusterBreakpointStateIds,
      dapBreakpoints: breakpoints,
    });

    this.sendResponse(reqSeq, 'setBreakpoints', { breakpoints });
  }

  private flushPendingClusterBreakpoints(): void {
    if (!this.isClusterAttach || !this.rap?.connected || !this.sessionId) return;
    if (this.pendingClusterBreakpointStateIds.length === 0) {
      logDebugProtocol('dap.flushPendingClusterBreakpoints.skip', {
        sessionId: this.sessionId,
        reason: 'no pending breakpoints',
      });
      return;
    }
    logDebugProtocol('dap.flushPendingClusterBreakpoints', {
      sessionId: this.sessionId,
      breakpoints: this.pendingClusterBreakpointStateIds,
    });
    this.rap.send({
      rap: 'DebugCommand',
      payload: {
        sessionId: this.sessionId,
        command: 'setBreakpoints',
        breakpoints: this.pendingClusterBreakpointStateIds,
      },
    });
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
      // T.13: Synthetic resolve frame when paused at a resolve point
      if (this.resolveDetail) {
        const rd = this.resolveDetail;
        const resolveDesc = `Resolve: ${rd.role} [${rd.selected.length}/${rd.candidates.length} selected] — ${rd.pipelineSummary || 'pipeline'}`;
        frames.push({
          id: 1,
          name: resolveDesc,
          source: {
            name: path.basename(this.rgFilePath),
            path: this.rgFilePath,
          },
          line: 1,
          column: 0,
        });
      } else {
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
      }

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

  private handleScopes(reqSeq: number, _args: Record<string, unknown>): void {
    const scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> = [
      { name: '$ctx', variablesReference: SCOPE_CTX, expensive: false },
      { name: '$self', variablesReference: SCOPE_SELF, expensive: false },
      { name: 'Instance', variablesReference: SCOPE_INSTANCE, expensive: false },
      { name: 'Held Messages', variablesReference: SCOPE_HELD, expensive: false },
    ];

    if (this.resolveDetail) {
      scopes.unshift({ name: 'Resolve', variablesReference: SCOPE_RESOLVE, expensive: false });
    }

    scopes.push({ name: 'Participants', variablesReference: SCOPE_PARTICIPANTS, expensive: false });
    scopes.push({ name: 'Registry', variablesReference: SCOPE_REGISTRY, expensive: true });

    this.sendResponse(reqSeq, 'scopes', { scopes });
  }

  private async handleVariables(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const ref = args.variablesReference as number;
    const variables: Array<{ name: string; value: string; variablesReference: number }> = [];

    if (this.paused) {
      // T.14: Resolve, participants, and registry scopes are handled uniformly
      if (ref >= SCOPE_RESOLVE && ref < SCOPE_RESOLVE + 1000) {
        this.extractResolveVariables(ref, variables);
      } else if (ref >= SCOPE_PARTICIPANTS && ref < SCOPE_PARTICIPANTS + 1000) {
        this.extractParticipantsVariables(variables);
      } else if (ref >= SCOPE_REGISTRY && ref < SCOPE_REGISTRY + 1000) {
        this.extractRegistryVariables(variables);
      } else if (this.isClusterAttach) {
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

          if (ref === SCOPE_CTX) {
            const ctx = (snapshot.ctx || {}) as Record<string, unknown>;
            for (const [key, value] of Object.entries(ctx)) {
              variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
            }
          } else if (ref === SCOPE_SELF) {
            const self = (snapshot.self || {}) as Record<string, unknown>;
            for (const [key, value] of Object.entries(self)) {
              variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
            }
          } else if (ref === SCOPE_INSTANCE) {
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
          } else if (ref === SCOPE_HELD) {
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

  /** T.14: Resolve scope variables. */
  private extractResolveVariables(
    ref: number,
    variables: Array<{ name: string; value: string; variablesReference: number }>,
  ): void {
    if (!this.resolveDetail) return;
    const rd = this.resolveDetail;

    if (ref === SCOPE_RESOLVE) {
      variables.push({ name: 'role', value: JSON.stringify(rd.role), variablesReference: 0 });
      variables.push({ name: 'pipelineSummary', value: JSON.stringify(rd.pipelineSummary), variablesReference: 0 });
      variables.push({ name: 'candidateCount', value: String(rd.candidates.length), variablesReference: 0 });
      variables.push({ name: 'selectedCount', value: String(rd.selected.length), variablesReference: 0 });
      variables.push({ name: 'candidates', value: `Array(${rd.candidates.length})`, variablesReference: SCOPE_RESOLVE_CANDIDATES });
      variables.push({ name: 'selected', value: `Array(${rd.selected.length})`, variablesReference: SCOPE_RESOLVE_SELECTED });
    } else if (ref === SCOPE_RESOLVE_CANDIDATES) {
      for (let i = 0; i < rd.candidates.length; i++) {
        variables.push({ name: `[${i}]`, value: JSON.stringify(rd.candidates[i]), variablesReference: 0 });
      }
    } else if (ref === SCOPE_RESOLVE_SELECTED) {
      for (let i = 0; i < rd.selected.length; i++) {
        variables.push({ name: `[${i}]`, value: JSON.stringify(rd.selected[i]), variablesReference: 0 });
      }
    }
  }

  /** T.14: Participants scope — role-to-agent bindings from the stopped detail. */
  private extractParticipantsVariables(
    variables: Array<{ name: string; value: string; variablesReference: number }>,
  ): void {
    const roleToAgent = this.stoppedDetail.roleToAgent as Record<string, string | string[]> | undefined;
    if (roleToAgent) {
      for (const [role, agents] of Object.entries(roleToAgent)) {
        const val = Array.isArray(agents) ? agents.join(', ') : String(agents);
        variables.push({ name: role, value: val, variablesReference: 0 });
      }
      return;
    }

    const agentName = this.stoppedDetail.agentName as string | undefined;
    const role = this.stoppedDetail.role as string | undefined;
    if (agentName && role) {
      variables.push({ name: role, value: agentName, variablesReference: 0 });
    } else if (agentName) {
      variables.push({ name: agentName, value: '(current agent)', variablesReference: 0 });
    } else {
      variables.push({ name: '(participants)', value: 'Not available in this debug mode', variablesReference: 0 });
    }
  }

  /** T.14: Registry scope — all registered agents with metadata from stopped detail. */
  private extractRegistryVariables(
    variables: Array<{ name: string; value: string; variablesReference: number }>,
  ): void {
    const registry = this.stoppedDetail.registry as Array<Record<string, unknown>> | undefined;
    if (registry) {
      for (const entry of registry) {
        const name = String(entry.agentName || entry.name || '?');
        const parts: string[] = [];
        if (entry.role) parts.push(`role=${entry.role}`);
        if (entry.protocol) parts.push(`proto=${entry.protocol}`);
        if (entry.status) parts.push(`status=${entry.status}`);
        if (entry.tags) parts.push(`tags=${JSON.stringify(entry.tags)}`);
        if (entry.capabilities) parts.push(`caps=${JSON.stringify(entry.capabilities)}`);
        variables.push({ name, value: parts.join(', ') || '(registered)', variablesReference: 0 });
      }
      return;
    }

    variables.push({ name: '(registry)', value: 'Not available in this debug mode', variablesReference: 0 });
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
    this.sinks?.debugPanel.updateDebugState(false, null, 0);
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
    this.sinks?.debugPanel.updateDebugState(false, null, 0);
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
    this.sinks?.debugPanel.updateDebugState(false, null, 0);
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
    this.sinks?.debugPanel.updateDebugState(false, null, 0);
    this.sendResponse(reqSeq, 'stepOut');
  }

  /** T.15: Handle SpawnStarted/SpawnCompleted/SpawnFailed trace events as DAP threads. */
  private handleSpawnTraceEvent(kind: string, payload: Record<string, unknown>): void {
    const agentName = (payload.agentName || '') as string;
    const roleName = (payload.roleName || '') as string;

    if (kind === 'SpawnStarted' && agentName) {
      if (!this.spawnedAgentThreads.has(agentName)) {
        const threadId = ++this.nextSpawnThreadId;
        this.spawnedAgentThreads.set(agentName, threadId);
        const label = roleName
          ? `Spawned: ${agentName} (${roleName})`
          : `Spawned: ${agentName}`;
        this.addThread(threadId, label, payload.instanceId as string | undefined);
      }
    } else if (kind === 'SpawnFailed' && agentName) {
      const threadId = this.spawnedAgentThreads.get(agentName);
      if (threadId !== undefined) {
        this.removeThread(threadId);
        this.spawnedAgentThreads.delete(agentName);
      }
    }
    // SpawnCompleted: thread stays active, no action needed
  }

  private addThread(threadId: number, name: string, instanceId?: string): void {
    this.activeThreads.set(threadId, { name, instanceId });
    this.sendEvent('thread', { reason: 'started', threadId });
  }

  private removeThread(threadId: number): void {
    this.activeThreads.delete(threadId);
    this.sendEvent('thread', { reason: 'exited', threadId });
  }

  private notifyBreakpointChanged(id: number, verified: boolean, message?: string): void {
    const bp = this.breakpointMap.get(id);
    if (bp) bp.verified = verified;
    const body: Record<string, unknown> = {
      reason: 'changed',
      breakpoint: { id, verified, ...(message ? { message } : {}) },
    };
    this.sendEvent('breakpoint', body);
  }

  private handleDisconnect(reqSeq: number): void {
    if (this.isClusterAttach && this.rap?.connected && this.sessionId) {
      this.rap.send({
        rap: 'DebugCommand',
        payload: { sessionId: this.sessionId, command: 'stop' },
      });
    }
    for (const id of this.activeThreads.keys()) {
      this.removeThread(id);
    }
    this.breakpointMap.clear();
    this.spawnedAgentThreads.clear();
    this.resolveDetail = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    if (!this.isClusterAttach) {
      this.rap?.close();
    }
    this.rap = null;
    if (ReagentDebugSession.activeSession === this) {
      ReagentDebugSession.activeSession = null;
    }
    this.sinks?.debugPanel.updateDebugState(false, null, 0);
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
  constructor(private readonly sinks?: DebugSinks) {}

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new ReagentDebugSession(this.sinks));
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
