import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  renderSequenceDiagram,
  SEQUENCE_DIAGRAM_CSS,
  SEQUENCE_DIAGRAM_SCRIPT,
  type SequenceDiagramData,
} from './renderers/sequenceDiagram';
import {
  renderStateMachineDiagram,
  STATE_MACHINE_CSS,
  type StateMachineDiagramData,
} from './renderers/stateMachineDiagram';
import type { ClusterPanelProvider } from './clusterPanel';
import { ReagentDebugSession } from './reagentDebugAdapter';
import {
  type PanelState,
  type PanelEvent,
  type PanelMode,
  type CompiledData,
  type MessageFieldSchema,
  type AgentInfo,
  type DebugError,
  type TraceEntry,
  transition,
  initialPanelState,
  getCompiledData,
  getDebugRenderOpts,
} from './panelState';

// ── Diagram compiler (lazy-loaded from bundled lang/) ───────────────

interface DiagramCompiler {
  parseProgram: (src: string) => any;
  emitIR: (proto: any) => any;
  resetIdCounter: () => void;
  buildSequenceDiagram: (graphs: Map<string, any>, name: string) => SequenceDiagramData;
  buildStateMachineDiagram: (graph: any) => StateMachineDiagramData;
}

let _diagramCompiler: DiagramCompiler | null = null;

async function getDiagramCompiler(extensionPath: string): Promise<DiagramCompiler> {
  if (_diagramCompiler) return _diagramCompiler;
  const langDir = path.join(extensionPath, 'lang');
  const parser = await import(path.join(langDir, 'parser.js'));
  const emitter = await import(path.join(langDir, 'ir-emitter.js'));
  const diagram = await import(path.join(langDir, 'diagram.js'));
  _diagramCompiler = {
    parseProgram: parser.parseProgram,
    emitIR: emitter.emitIR,
    resetIdCounter: emitter.resetIdCounter,
    buildSequenceDiagram: diagram.buildSequenceDiagram,
    buildStateMachineDiagram: diagram.buildStateMachineDiagram,
  };
  return _diagramCompiler;
}

// ── Message types from webview ──────────────────────────────────────

interface DiagramMessage {
  type: string;
  stateId?: string;
  line?: number;
  file?: string;
  role?: string;
  agentName?: string;
  protocolName?: string;
  input?: string;
  command?: string;
  breakpoints?: string[];
  position?: number;
}

// ── The Panel ───────────────────────────────────────────────────────

export class ReagentDiagramPanel {
  public static readonly viewType = 'reagentDiagram';
  private static instance: ReagentDiagramPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private clusterPanel: ClusterPanelProvider | null = null;
  private stoppedListener: vscode.Disposable | null = null;

  private state: PanelState;

  public static getInstance(): ReagentDiagramPanel | undefined {
    return ReagentDiagramPanel.instance;
  }

  public static createOrShow(extensionUri: vscode.Uri, clusterPanel?: ClusterPanelProvider): ReagentDiagramPanel {
    const column = vscode.ViewColumn.Beside;
    if (ReagentDiagramPanel.instance) {
      if (clusterPanel) ReagentDiagramPanel.instance.clusterPanel = clusterPanel;
      ReagentDiagramPanel.instance.panel.reveal(column);
      return ReagentDiagramPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      ReagentDiagramPanel.viewType,
      'Protocol View',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ReagentDiagramPanel.instance = new ReagentDiagramPanel(panel, extensionUri, clusterPanel);
    return ReagentDiagramPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel, private extensionUri: vscode.Uri, clusterPanel?: ClusterPanelProvider) {
    this.clusterPanel = clusterPanel ?? null;
    this.panel = panel;
    this.state = initialPanelState();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: DiagramMessage) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // Watch active .rg editor
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.languageId === 'reagent') {
          this.compileAndTransition(editor.document);
        }
      }),
    );

    // Recompile on save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'reagent') {
          this.compileAndTransition(doc);
        }
      }),
    );

    // Update cluster agents when cluster state changes
    if (this.clusterPanel) {
      this.disposables.push(
        this.clusterPanel.onDidChangeTreeData(() => this.syncClusterState()),
      );
    }

    // Listen for RAP Stopped events (cluster debug)
    this.listenForStoppedEvents();

    // When a DAP debug session ends, transition to replay
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession(session => {
        if (session.type === 'reagent' && this.state.context.mode === 'debug') {
          const error = this.state.context.error;
          const finalState = error ? 'failed' as const : 'completed' as const;
          this.dispatch({ type: 'debugSessionEnded', finalState });
        }
      }),
    );

    // Try to compile the currently active .rg file
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'reagent') {
      this.compileAndTransition(editor.document);
    } else {
      this.renderPanel();
    }
  }

  // ── State machine dispatch ──────────────────────────────────────

  private dispatch(event: PanelEvent): void {
    const prev = this.state;
    this.state = transition(this.state, event);

    const modeChanged = prev.context.mode !== this.state.context.mode;

    // In debug mode, Stopped events use lightweight postMessage update
    if (event.type === 'debugStopped' && !modeChanged) {
      this.postDebugUpdate();
      return;
    }

    // debugError also lightweight
    if (event.type === 'debugError' && !modeChanged) {
      this.postErrorUpdate(event.error);
      return;
    }

    // debugTraceEvent doesn't need visual update
    if (event.type === 'debugTraceEvent' && !modeChanged) {
      return;
    }

    // replaySeek is lightweight
    if (event.type === 'replaySeek' && !modeChanged) {
      this.postReplaySeek();
      return;
    }

    // Cluster state changes use lightweight trigger bar update when in source mode
    if ((event.type === 'clusterConnected' || event.type === 'clusterDisconnected') && !modeChanged) {
      this.updateTriggerBar();
      return;
    }

    // Everything else: full re-render
    this.renderPanel();
  }

  // ── Public API (called by DiagramController, extension commands) ─

  /**
   * Called by DiagramController when debug Stopped event arrives.
   * This is the SINGLE path for debug state updates — no more race.
   */
  public updateDebug(activeStateId?: string, visitedStateIds?: Set<string>): void {
    if (this.state.context.mode === 'debug' && activeStateId) {
      this.dispatch({
        type: 'debugStopped',
        stateId: activeStateId,
      });
    } else if (!activeStateId && !visitedStateIds) {
      // Session ended signal from DiagramController — ignore if we already transitioned
    }
  }

  public highlightState(stateId: string): void {
    this.panel.webview.postMessage({ type: 'highlightState', stateId });
  }

  public sendDebugCommand(command: string): void {
    const rap = this.clusterPanel?.getRapClient();
    const ctx = this.state.context;
    if (ctx.mode !== 'debug') return;
    if (!rap?.connected) return;

    rap.send({
      rap: 'DebugCommand',
      payload: { sessionId: ctx.sessionId, command },
    });

    if (command === 'stop') {
      vscode.debug.stopDebugging();
    }
  }

  public isDebugActive(): boolean {
    return this.state.context.mode === 'debug';
  }

  public getDebugState(): { active: boolean; stateId: string | null; stepCount: number } {
    const ctx = this.state.context;
    if (ctx.mode === 'debug') {
      return {
        active: true,
        stateId: ctx.activeStateId,
        stepCount: ctx.visitedStates.size,
      };
    }
    return { active: false, stateId: null, stepCount: 0 };
  }

  public getMode(): PanelMode {
    return this.state.context.mode;
  }

  // ── Compile .rg → dispatch open/update event ────────────────────

  private async compileAndTransition(document: vscode.TextDocument): Promise<void> {
    try {
      const compiler = await getDiagramCompiler(this.extensionUri.fsPath);
      const source = document.getText();
      const parseResult = compiler.parseProgram(source);
      if (!parseResult.ok) {
        const errs = (parseResult.errors ?? []).map((e: any) => e.message ?? String(e)).join('\n');
        this.renderError(`Parse error:\n${errs}`);
        return;
      }

      const items = parseResult.ast.items;
      const protocols = items.filter((i: any) => i.kind === 'ProtocolDef');
      if (protocols.length === 0) {
        this.renderError('No protocol definition found in this file.');
        return;
      }

      const proto = protocols[0];
      compiler.resetIdCounter();
      const result = compiler.emitIR(proto);
      if (!result.ok) {
        const errs = (result.errors ?? []).map((e: any) => e.message ?? String(e)).join('\n');
        this.renderError(`IR emit error:\n${errs}`);
        return;
      }

      const graphs = new Map<string, any>();
      const roles: string[] = [];
      for (const [role, graph] of result.graphs) {
        graphs.set(`${proto.name}.${role}`, graph);
        roles.push(role);
      }

      const sourceMap = new Map<string, number>();
      for (const entry of result.sourceMap ?? []) {
        if (entry.line != null) sourceMap.set(entry.stateId, entry.line);
      }

      const seqDiagram = compiler.buildSequenceDiagram(graphs, proto.name);
      const stateMachines = new Map<string, StateMachineDiagramData>();
      for (const [, graph] of graphs) {
        const sm = compiler.buildStateMachineDiagram(graph);
        stateMachines.set(sm.role, sm);
      }

      const messageDefs = items.filter((i: any) => i.kind === 'MessageDef');
      const triggers: import('./panelState').TriggerInfo[] = [];
      for (const t of proto.triggers ?? []) {
        let schema: MessageFieldSchema[] | null = null;
        if (t.withType) {
          const msgDef = messageDefs.find((m: any) => m.name === t.withType);
          if (msgDef) schema = extractFieldSchemas(msgDef.fields ?? []);
        }
        triggers.push({
          kind: t.triggerKind,
          withType: t.withType,
          cronExpr: t.cronExpr,
          topic: t.topic,
          schema,
        });
      }
      const firstWithType = triggers.find(t => t.withType);
      const inputTypeName = firstWithType?.withType ?? null;
      const inputMessageSchema = firstWithType?.schema ?? null;

      const projectVersion = seqDiagram.version || findProjectVersion(document.uri.fsPath);

      // Build stateId alias map: maps runtime stateIds from all roles
      // to the diagram element's stateId (which comes from the initiator's graph).
      const stateIdAlias = buildStateIdAliasMap(seqDiagram, graphs);

      const compiledData: CompiledData = {
        protocolName: proto.name,
        version: projectVersion,
        sequenceDiagram: seqDiagram,
        stateMachines,
        sourceFile: document.uri.fsPath,
        sourceMap,
        roles,
        inputMessageSchema,
        inputMessageName: inputTypeName,
        triggers,
        stateIdAlias,
      };

      const isNew = this.state.context.mode === 'idle';
      this.dispatch({
        type: isNew ? 'openRgFile' : 'rgFileUpdated',
        compiledData,
      });
    } catch (err) {
      this.renderError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Message handling from webview ─────────────────────────────────

  private handleMessage(msg: DiagramMessage): void {
    switch (msg.type) {
      case 'switchView':
        this.state = {
          ...this.state,
          viewKind: this.state.viewKind === 'sequence' ? 'statemachine' : 'sequence',
        };
        this.renderPanel();
        break;
      case 'selectRole':
        if (msg.role) {
          this.state = { ...this.state, selectedRole: msg.role };
          this.renderPanel();
        }
        break;
      case 'clickNode':
        if (msg.line && msg.file) this.revealSource(msg.file, msg.line);
        break;
      case 'trigger':
        this.handleTrigger(msg);
        break;
      case 'debugTrigger':
        this.handleDebugTrigger(msg);
        break;
      case 'debugAction':
        if (msg.command) this.sendDebugCommand(msg.command);
        break;
      case 'decompile':
        this.showDecompiledProtocol();
        break;
      case 'decompileFromRC':
        this.showDecompiledFromRC();
        break;
      case 'closeReplay':
        this.dispatch({ type: 'closeReplay' });
        break;
      case 'replaySeek':
        if (msg.position != null) this.dispatch({ type: 'replaySeek', position: msg.position });
        break;
      case 'toggleBreakpoint':
        this.toggleBreakpoint(msg.stateId);
        break;
    }
  }

  private toggleBreakpoint(stateId?: string): void {
    if (!stateId) return;
    const ctx = this.state.context;
    if (ctx.mode !== 'source' && ctx.mode !== 'debug') return;
    const bp = new Set(ctx.breakpoints);
    if (bp.has(stateId)) bp.delete(stateId);
    else bp.add(stateId);
    if (ctx.mode === 'source') {
      this.state = { ...this.state, context: { ...ctx, breakpoints: bp } };
    } else if (ctx.mode === 'debug') {
      this.state = { ...this.state, context: { ...ctx, breakpoints: bp } };
    }
  }

  // ── Trigger / Debug trigger ─────────────────────────────────────

  private handleTrigger(msg: DiagramMessage): void {
    const rap = this.clusterPanel?.getRapClient();
    if (!rap?.connected) {
      vscode.window.showErrorMessage('Not connected to cluster. Run "Reagent: Connect to Cluster" first.');
      return;
    }
    if (!msg.agentName || !msg.protocolName) {
      vscode.window.showWarningMessage('Select an agent to trigger');
      return;
    }

    let input: Record<string, unknown> = {};
    try {
      const raw = (msg.input ?? '').trim();
      if (raw) input = JSON.parse(raw);
    } catch {
      vscode.window.showErrorMessage('Invalid JSON in input field');
      return;
    }

    rap.send({
      rap: 'TriggerOnCluster',
      payload: { agentName: msg.agentName, protocolName: msg.protocolName, input },
    });
    vscode.window.showInformationMessage(`Triggered ${msg.protocolName} on ${msg.agentName}`);
  }

  private async handleDebugTrigger(msg: DiagramMessage): Promise<void> {
    const rap = this.clusterPanel?.getRapClient();
    if (!rap?.connected) {
      vscode.window.showErrorMessage('Not connected to cluster.');
      return;
    }
    if (!msg.agentName || !msg.protocolName) {
      vscode.window.showWarningMessage('Select an agent to debug');
      return;
    }

    let input: Record<string, unknown> = {};
    try {
      const raw = (msg.input ?? '').trim();
      if (raw) input = JSON.parse(raw);
    } catch {
      vscode.window.showErrorMessage('Invalid JSON in input field');
      return;
    }

    const compiledData = getCompiledData(this.state.context);
    if (!compiledData) {
      vscode.window.showErrorMessage('No compiled protocol data');
      return;
    }

    const sessionId = `dbg-${Date.now().toString(36)}`;
    const breakpoints = msg.breakpoints ? new Set(msg.breakpoints) : new Set<string>();

    // Transition to debug mode
    this.dispatch({
      type: 'debugStart',
      sessionId,
      sessionType: 'cluster',
      compiledData,
      breakpoints,
    });

    rap.send({
      rap: 'TriggerOnCluster',
      payload: {
        agentName: msg.agentName,
        protocolName: msg.protocolName,
        input,
        mode: 'debug',
        sessionId,
        breakpoints: [...breakpoints],
      },
    });

    // Start DAP session
    const rgFile = compiledData.sourceFile;
    ReagentDebugSession.pendingClusterRap = rap;

    if (compiledData.sourceMap) {
      const entries: Array<{ stateId: string; protocolName: string; role: string; file: string; line: number; column: number }> = [];
      for (const [stateId, line] of compiledData.sourceMap) {
        entries.push({
          stateId,
          protocolName: compiledData.protocolName,
          role: '',
          file: rgFile,
          line,
          column: 0,
        });
      }
      ReagentDebugSession.pendingSourceMap = entries;
    }

    await vscode.debug.startDebugging(undefined, {
      type: 'reagent',
      request: 'launch',
      name: `Cluster Debug: ${msg.protocolName}`,
      rgFile,
      clusterSessionId: sessionId,
      __noDebug: false,
    });
  }

  // ── Cluster state sync ──────────────────────────────────────────

  private syncClusterState(): void {
    const connected = !!this.clusterPanel?.getRapClient()?.connected;
    const agents = this.getClusterAgentsForProtocol(true);
    this.state = {
      ...this.state,
      cluster: connected ? { connected, agents } : null,
    };
    this.updateTriggerBar();
  }

  private getClusterAgentsForProtocol(initiatorsOnly: boolean): AgentInfo[] {
    if (!this.clusterPanel) return [];
    const compiledData = getCompiledData(this.state.context);
    if (!compiledData) return [];

    const clusterState = this.clusterPanel.getState();
    const protoName = compiledData.protocolName;

    let agents = clusterState.agents.filter(a => a.protocolName === protoName);

    if (agents.length === 0) {
      const proto = clusterState.protocols.find(p => p.name === protoName);
      if (proto && proto.boundAgents.length > 0) {
        const bound = new Set(proto.boundAgents);
        agents = clusterState.agents.filter(a => bound.has(a.agentName));
      }
    }

    if (agents.length === 0) {
      const diagramRoles = new Set(compiledData.roles);
      agents = clusterState.agents.filter(a => diagramRoles.has(a.roleName));
    }

    if (initiatorsOnly) {
      const initiatorRoles = new Set(
        compiledData.sequenceDiagram.participants
          .filter(p => p.isInitiator)
          .map(p => p.name)
      );
      if (initiatorRoles.size > 0) {
        const filtered = agents.filter(a => initiatorRoles.has(a.roleName));
        if (filtered.length > 0) agents = filtered;
      }
    }

    return agents.map(a => ({ name: a.agentName, role: a.roleName, node: a.nodeId }));
  }

  /**
   * Build a role → agent-name[] map from cluster state for all roles
   * (not just initiators). Used by the renderer for live binding annotations.
   */
  private buildClusterBindings(): Map<string, string[]> | undefined {
    if (!this.clusterPanel) return undefined;
    const connected = !!this.state.cluster?.connected;
    if (!connected) return undefined;

    const compiledData = getCompiledData(this.state.context);
    if (!compiledData) return undefined;

    const clusterState = this.clusterPanel.getState();
    const protoName = compiledData.protocolName;
    const diagramRoles = new Set(compiledData.roles);

    let agents = clusterState.agents.filter(a => a.protocolName === protoName);
    if (agents.length === 0) {
      const proto = clusterState.protocols.find(p => p.name === protoName);
      if (proto && proto.boundAgents.length > 0) {
        const bound = new Set(proto.boundAgents);
        agents = clusterState.agents.filter(a => bound.has(a.agentName));
      }
    }
    if (agents.length === 0) {
      agents = clusterState.agents.filter(a => diagramRoles.has(a.roleName));
    }

    if (agents.length === 0) return undefined;

    const bindings = new Map<string, string[]>();
    for (const a of agents) {
      const list = bindings.get(a.roleName) ?? [];
      list.push(a.agentName);
      bindings.set(a.roleName, list);
    }
    return bindings;
  }

  // ── RAP event listeners ─────────────────────────────────────────

  private listenForStoppedEvents(): void {
    this.ensureStoppedListener();
    if (this.clusterPanel) {
      this.disposables.push(
        this.clusterPanel.onDidChangeTreeData(() => this.ensureStoppedListener()),
      );
    }
  }

  private ensureStoppedListener(): void {
    const rap = this.clusterPanel?.getRapClient();
    if (!rap) return;

    this.stoppedListener?.dispose();

    this.stoppedListener = rap.on('Stopped', (msg) => {
      if (this.state.context.mode !== 'debug') return;
      const ctx = this.state.context;
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const sessionId = payload.sessionId as string;
      if (sessionId && sessionId !== ctx.sessionId) return;

      const stateId = payload.stateId as string | undefined;
      const stateKind = payload.stateKind as string | undefined;
      const agentName = payload.agentName as string | undefined;
      const reason = payload.reason as string | undefined;

      if (stateId) {
        // Cache for DAP adapter
        if (!ReagentDebugSession.activeSession) {
          ReagentDebugSession.pendingStoppedPayload = payload;
        }

        this.dispatch({
          type: 'debugStopped',
          stateId,
          stateKind,
          agentName,
          reason,
        });
      }
    });
    this.disposables.push(this.stoppedListener);

    // TraceEvent listener for errors
    const traceListener = rap.on('TraceEvent', (msg) => {
      if (this.state.context.mode !== 'debug') return;
      const p = (msg.payload ?? {}) as Record<string, unknown>;
      const kind = (p.kind || '') as string;

      // Add to trace
      this.dispatch({
        type: 'debugTraceEvent',
        entry: {
          kind,
          stateId: (p.stateId || '') as string,
          agentName: (p.agentName || '') as string,
          timestamp: Date.now(),
          detail: p,
        },
      });

      if (kind === 'ProtocolFailed') {
        const error = (p.error || 'Unknown error') as string;
        const agentName = (p.agentName || '') as string;
        const stateId = (this.state.context.mode === 'debug' ? this.state.context.activeStateId : null) || '';
        this.dispatch({
          type: 'debugError',
          error: { stateId, agentName, message: error },
        });
      } else if (kind === 'ActionFailed') {
        const error = (p.error || p.message || 'Action failed') as string;
        const stateId = ((p.stateId || (this.state.context.mode === 'debug' ? this.state.context.activeStateId : '')) as string);
        const agentName = (p.agentName || '') as string;
        this.dispatch({
          type: 'debugError',
          error: { stateId, agentName, message: error },
        });
      }
    });
    this.disposables.push(traceListener);
  }

  // ── Lightweight postMessage updates (no full re-render) ─────────

  private postDebugUpdate(): void {
    const ctx = this.state.context;
    if (ctx.mode !== 'debug') return;
    this.panel.webview.postMessage({
      type: 'debugStopped',
      stateId: ctx.activeStateId,
      visitedStates: [...ctx.visitedStates],
      stepCount: ctx.visitedStates.size,
    });
  }

  private postErrorUpdate(error: DebugError): void {
    this.panel.webview.postMessage({
      type: 'debugError',
      stateId: error.stateId,
      agentName: error.agentName,
      error: error.message,
    });
  }

  private postReplaySeek(): void {
    const ctx = this.state.context;
    if (ctx.mode !== 'replay') return;
    const debugOpts = getDebugRenderOpts(ctx);
    const stoppedCount = ctx.trace.filter(e => e.kind === 'Stopped').length;
    this.panel.webview.postMessage({
      type: 'replaySeek',
      activeStateId: debugOpts?.activeStateId ?? null,
      visitedStates: debugOpts?.visitedStateIds ? [...debugOpts.visitedStateIds] : [],
      position: ctx.replayPosition,
      total: stoppedCount,
    });
  }

  private updateTriggerBar(): void {
    const connected = !!this.state.cluster?.connected;
    const agents = this.getClusterAgentsForProtocol(true);
    const compiledData = getCompiledData(this.state.context);
    const protoName = compiledData?.protocolName ?? '(no protocol)';
    this.panel.webview.postMessage({
      type: 'triggerBarUpdate',
      connected,
      agents,
      protoName,
      inputSchema: compiledData?.inputMessageSchema ?? null,
      inputMessageName: compiledData?.inputMessageName ?? null,
      triggers: compiledData?.triggers ?? [],
    });
  }

  // ── Navigation ──────────────────────────────────────────────────

  private revealSource(file: string, line: number): void {
    const uri = vscode.Uri.file(file);
    vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line - 1, 0, line - 1, 0),
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  // ── Decompile ───────────────────────────────────────────────────

  private async showDecompiledProtocol(): Promise<void> {
    const compiledData = getCompiledData(this.state.context);
    if (!compiledData) {
      vscode.window.showWarningMessage('No compiled protocol data available');
      return;
    }
    const text = decompileFromSequenceDiagram(compiledData);
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'reagent' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
  }

  private async showDecompiledFromRC(): Promise<void> {
    const rap = this.clusterPanel?.getRapClient();
    if (!rap || !rap.connected) {
      vscode.window.showWarningMessage('Not connected to ROS');
      return;
    }

    const compiledData = getCompiledData(this.state.context);
    const protoName = compiledData?.protocolName;
    rap.send({
      rap: 'GetDeployedIR',
      payload: { protocolName: protoName || '' },
    });

    const disposable = rap.on('DeployedIR', async (msg) => {
      disposable.dispose();
      const payload = (msg.payload || {}) as Record<string, unknown>;
      const irGraphs = (payload.irGraphs || {}) as Record<string, any>;
      const version = (payload.version || '') as string;

      if (Object.keys(irGraphs).length === 0) {
        vscode.window.showWarningMessage('No deployed IR found on RC');
        return;
      }

      const text = decompileFromIRGraphs(irGraphs, protoName || 'unknown', version);
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'reagent' });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    });

    setTimeout(() => disposable.dispose(), 5000);
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  private dispose(): void {
    ReagentDiagramPanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  // ── Render: mode-based ──────────────────────────────────────────

  private renderPanel(): void {
    const ctx = this.state.context;
    const compiledData = getCompiledData(ctx);
    const isSeq = this.state.viewKind === 'sequence';

    const protoLabel = compiledData?.protocolName ?? 'Protocol';
    this.panel.title = `${protoLabel} — ${isSeq ? 'Sequence' : 'State Machine'}`;
    this.panel.webview.html = this.buildHtml();
  }

  private renderError(message: string): void {
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family, monospace); background: var(--vscode-editor-background, #1e1e1e);
         color: var(--vscode-errorForeground, #f48771); padding: 24px; white-space: pre-wrap; }
</style></head><body>${esc(message)}</body></html>`;
  }

  private buildHtml(): string {
    const ctx = this.state.context;
    const mode = ctx.mode;
    const isSeq = this.state.viewKind === 'sequence';
    const compiledData = getCompiledData(ctx);
    const protoName = compiledData?.protocolName ?? '(no protocol)';
    const roles = compiledData?.roles ?? [];

    // Build diagram HTML
    let diagramHtml: string;

    if (mode === 'idle') {
      diagramHtml = '<div class="idle-placeholder">Open a <code>.rg</code> file to see the protocol diagram</div>';
    } else {
      const debugOpts = getDebugRenderOpts(ctx);
      const clusterBindings = this.buildClusterBindings();
      const renderOpts = {
        sourceFile: compiledData?.sourceFile ?? '',
        sourceMap: compiledData?.sourceMap,
        debug: debugOpts,
        clusterBindings,
      };

      if (!compiledData) {
        diagramHtml = '<div class="idle-placeholder">No protocol data</div>';
      } else if (isSeq) {
        diagramHtml = renderSequenceDiagram(compiledData.sequenceDiagram, renderOpts);
      } else {
        const sm = compiledData.stateMachines.get(this.state.selectedRole);
        diagramHtml = sm
          ? renderStateMachineDiagram(sm, renderOpts)
          : '<div style="color:#888;padding:40px">Select a role</div>';
      }
    }

    // Cluster info for trigger bar
    const clusterAgents = this.getClusterAgentsForProtocol(true);
    const connected = !!this.state.cluster?.connected;
    const agentsJson = JSON.stringify(clusterAgents);
    const inputSchemaJson = JSON.stringify(compiledData?.inputMessageSchema ?? null);
    const inputMsgName = compiledData?.inputMessageName ?? null;
    const triggersJson = JSON.stringify(compiledData?.triggers ?? []);

    // Mode badge
    const modeBadge = this.getModeBadgeHtml(mode);

    // Mode-specific bars
    const infoBars = this.getModeSpecificBars(ctx, compiledData, protoName, connected, clusterAgents);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${getBaseStyles()}
${SEQUENCE_DIAGRAM_CSS}
${STATE_MACHINE_CSS}
</style>
</head>
<body data-mode="${mode}">
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="proto-name">${esc(protoName)}</span>
      ${compiledData?.version ? `<span class="version-tag">v${esc(compiledData.version)}</span>` : ''}
      ${modeBadge}
      <button class="toolbar-icon-btn" id="btn-decompile" title="Decompile from local IR">&#x1F50D;</button>
      <button class="toolbar-icon-btn" id="btn-decompile-rc" title="Fetch &amp; decompile from RC (deployed)">&#x2601;</button>
    </div>
    <div class="toolbar-center">
      <button class="tab ${isSeq ? 'active' : ''}" id="btn-seq">Sequence</button>
      <button class="tab ${!isSeq ? 'active' : ''}" id="btn-sm">State Machine</button>
    </div>
    <div class="toolbar-right">
      ${!isSeq ? `<select id="role-select" class="toolbar-select">
        ${roles.map(r => `<option value="${esc(r)}" ${this.state.selectedRole === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select>` : ''}
    </div>
  </div>
  ${infoBars}
  <div class="diagram-container">
    ${diagramHtml}
  </div>
  <div class="diagram-tooltip" id="diagram-tooltip"></div>
  <script>
    ${this.getWebviewScript(mode, protoName, agentsJson, inputSchemaJson, inputMsgName, triggersJson, compiledData?.stateIdAlias)}
  </script>
  <script>${SEQUENCE_DIAGRAM_SCRIPT}</script>
</body>
</html>`;
  }

  // ── Mode badge ──────────────────────────────────────────────────

  private getModeBadgeHtml(mode: PanelMode): string {
    const badges: Record<PanelMode, { label: string; cls: string }> = {
      idle: { label: 'IDLE', cls: 'mode-badge-idle' },
      source: { label: 'SOURCE', cls: 'mode-badge-source' },
      deployed: { label: 'DEPLOYED', cls: 'mode-badge-deployed' },
      debug: { label: 'DEBUG', cls: 'mode-badge-debug' },
      replay: { label: 'REPLAY', cls: 'mode-badge-replay' },
    };
    const b = badges[mode];
    return `<span class="mode-badge ${b.cls}">${b.label}</span>`;
  }

  // ── Mode-specific bars (info, trigger, debug status, replay) ────

  private getModeSpecificBars(
    ctx: import('./panelState').ModeContext,
    compiledData: CompiledData | null,
    protoName: string,
    connected: boolean,
    agents: AgentInfo[],
  ): string {
    let html = '';

    // Protocol info bar (source, deployed, debug, replay)
    if (compiledData && ctx.mode !== 'idle') {
      html += this.getProtocolInfoBarHtml(compiledData, ctx.mode);
    }

    // Trigger bar (source and deployed modes only)
    if (ctx.mode === 'source' || ctx.mode === 'deployed') {
      html += this.getTriggerBarHtml(protoName, connected, agents);
    }

    // Debug status bar
    if (ctx.mode === 'debug') {
      const stateLabel = ctx.activeStateId ?? '...';
      const stepCount = ctx.visitedStates.size;
      html += `<div class="debug-status-bar">
        <span class="debug-status-dot"></span>
        <span class="ctrl-status">Paused at <span class="state-name">${esc(stateLabel)}</span> <span class="step-count">step ${stepCount}</span></span>
      </div>`;
    }

    // Replay bar
    if (ctx.mode === 'replay') {
      const finalLabel = ctx.finalState === 'failed' ? 'FAILED' : ctx.finalState === 'completed' ? 'COMPLETED' : 'STOPPED';
      const finalCls = ctx.finalState === 'failed' ? 'replay-failed' : ctx.finalState === 'completed' ? 'replay-completed' : 'replay-stopped';
      const stoppedEvents = ctx.trace.filter(e => e.kind === 'Stopped');
      const stoppedCount = stoppedEvents.length;
      const traceLen = ctx.trace.length;
      // replayPosition is now an index into stopped events only
      const currentStep = Math.min(ctx.replayPosition, Math.max(0, stoppedCount - 1));

      html += `<div class="replay-bar">
        <span class="replay-badge ${finalCls}">${finalLabel}</span>
        <span class="replay-info">${stoppedCount} states · ${traceLen} events</span>
        ${ctx.error ? `<span class="replay-error-hint">&#x26A0; ${esc(ctx.error.agentName)} at ${esc(ctx.error.stateId)}: ${esc(ctx.error.message)}</span>` : ''}
        <div class="replay-controls">
          <button class="replay-btn" id="replay-back" title="Previous state">&#x25C0;</button>
          <input type="range" id="replay-scrubber" class="replay-scrubber" min="0" max="${Math.max(0, stoppedCount - 1)}" value="${currentStep}" />
          <button class="replay-btn" id="replay-fwd" title="Next state">&#x25B6;</button>
          <span class="replay-position" id="replay-pos">${currentStep + 1} / ${stoppedCount}</span>
        </div>
        <button class="replay-close-btn" id="replay-close">✕ Close Replay</button>
      </div>`;
    }

    return html;
  }

  private getProtocolInfoBarHtml(data: CompiledData, mode: PanelMode): string {
    const roles = data.roles.join(', ');
    const stateCount = data.sourceMap.size;
    const msgCount = data.sequenceDiagram.elements.filter(e => e.kind === 'message').length;
    const actionCount = data.sequenceDiagram.elements.filter(e => e.kind === 'action').length;
    const scatterCount = data.sequenceDiagram.elements.filter(e => e.kind === 'scatter_start').length;
    const versionHtml = data.version
      ? `<span class="proto-info-version">v${esc(data.version)}</span><span class="proto-info-sep"></span>`
      : '';
    return `<div class="proto-info-bar">
      ${versionHtml}
      <span class="proto-info-item"><span class="info-label">roles</span> ${esc(roles)}</span>
      <span class="proto-info-sep"></span>
      <span class="proto-info-item"><span class="info-label">states</span> ${stateCount}</span>
      <span class="proto-info-item"><span class="info-label">msg</span> ${msgCount}</span>
      <span class="proto-info-item"><span class="info-label">act</span> ${actionCount}</span>
      ${scatterCount > 0 ? `<span class="proto-info-item"><span class="info-label">scatter</span> ${scatterCount}</span>` : ''}
    </div>`;
  }

  private getTriggerBarHtml(
    protoName: string,
    connected: boolean,
    agents: AgentInfo[],
  ): string {
    const statusClass = !connected ? 'disconnected' : agents.length > 0 ? 'connected' : '';
    const statusText = !connected
      ? 'not connected'
      : agents.length > 0
        ? `${agents.length} agent(s)`
        : `no agents deployed for ${esc(protoName)}`;

    const agentOptions = agents
      .map(a => `<option value="${esc(a.name)}">${esc(a.name)} (${esc(a.role)} @ ${esc(a.node)})</option>`)
      .join('');

    const compiledData = getCompiledData(this.state.context);
    const triggersList = compiledData?.triggers ?? [];
    const hasTriggers = triggersList.length > 0;
    const showTriggerSelect = triggersList.length > 1;

    const triggerOptions = triggersList
      .map((t, i) => {
        const label = t.kind === 'invoke'
          ? `on invoke${t.withType ? ` with ${t.withType}` : ''}`
          : t.kind === 'cron'
            ? `on cron (${t.cronExpr ?? '...'})`
            : `on event${t.topic ? ` "${t.topic}"` : ''}${t.withType ? ` with ${t.withType}` : ''}`;
        return `<option value="${i}">${esc(label)}</option>`;
      })
      .join('');

    const firstTrigger = triggersList[0];
    const msgLabel = firstTrigger?.withType
      ? `Input: ${esc(firstTrigger.withType)}`
      : 'Input';

    return `<div class="trigger-bar">
      <div class="trigger-header" id="trigger-toggle">
        <span id="trigger-icon">▸</span> Trigger
        <span class="trigger-status ${statusClass}">${statusText}</span>
      </div>
      <div class="trigger-body" id="trigger-body" style="display:none">
        <div class="trigger-row">
          <label for="trigger-agent">Agent</label>
          <select id="trigger-agent" class="trigger-select">${agentOptions}</select>
        </div>
        ${showTriggerSelect ? `<div class="trigger-row">
          <label for="trigger-kind">Trigger</label>
          <select id="trigger-kind" class="trigger-select">${triggerOptions}</select>
        </div>` : ''}
        <div class="trigger-section-label" id="trigger-msg-label">${msgLabel}</div>
        <div id="trigger-fields" class="trigger-fields"></div>
        <div class="trigger-actions">
          <button id="trigger-btn" class="trigger-button">▶ Trigger</button>
          <button id="debug-trigger-btn" class="trigger-button debug-button">🔍 Debug</button>
        </div>
      </div>
    </div>`;
  }

  // ── Webview JavaScript (mode-aware) ─────────────────────────────

  private getWebviewScript(
    mode: PanelMode,
    protoName: string,
    agentsJson: string,
    inputSchemaJson: string,
    inputMsgName: string | null,
    triggersJson: string,
    aliasMap?: Map<string, string>,
  ): string {
    // Serialize alias map for the webview
    const aliasObj: Record<string, string> = {};
    if (aliasMap) {
      for (const [k, v] of aliasMap) aliasObj[k] = v;
    }

    return `
    var vscode = acquireVsCodeApi();
    var panelMode = '${mode}';
    var clusterAgents = ${agentsJson};
    var protoName = ${JSON.stringify(protoName)};
    var currentInputSchema = ${inputSchemaJson};
    var currentInputMsgName = ${JSON.stringify(inputMsgName)};
    var protocolTriggers = ${triggersJson};
    var selectedTriggerIdx = 0;
    var stateIdAlias = ${JSON.stringify(aliasObj)};

    // Resolve a runtime stateId to the diagram's canonical stateId
    function resolveStateId(sid) {
      return stateIdAlias[sid] || sid;
    }

    // ── Toolbar buttons ──
    document.getElementById('btn-seq')?.addEventListener('click', function() { vscode.postMessage({ type: 'switchView' }); });
    document.getElementById('btn-sm')?.addEventListener('click', function() { vscode.postMessage({ type: 'switchView' }); });
    document.getElementById('btn-decompile')?.addEventListener('click', function() { vscode.postMessage({ type: 'decompile' }); });
    document.getElementById('btn-decompile-rc')?.addEventListener('click', function() { vscode.postMessage({ type: 'decompileFromRC' }); });
    document.getElementById('role-select')?.addEventListener('change', function(e) {
      vscode.postMessage({ type: 'selectRole', role: e.target.value });
    });

    // ── Breakpoint state IDs ──
    var breakpointStates = new Set();

    // ── Diagram element click (source nav + breakpoint toggle) ──
    document.querySelectorAll('[data-state-id]').forEach(function(el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function(e) {
        var stateId = el.getAttribute('data-state-id');
        if (!stateId) return;

        if (e.shiftKey || e.altKey) {
          if (breakpointStates.has(stateId)) {
            breakpointStates.delete(stateId);
            el.classList.remove('debug-breakpoint');
          } else {
            breakpointStates.add(stateId);
            el.classList.add('debug-breakpoint');
          }
          vscode.postMessage({ type: 'toggleBreakpoint', stateId: stateId });
          e.stopPropagation();
          return;
        }

        var line = parseInt(el.getAttribute('data-src-line'), 10);
        var file = el.getAttribute('data-src-file');
        if (line && file) vscode.postMessage({ type: 'clickNode', line: line, file: file });
      });
    });

    // ── Tooltip ──
    var tooltip = document.getElementById('diagram-tooltip');
    document.querySelectorAll('[data-state-id]').forEach(function(el) {
      el.addEventListener('mouseenter', function() {
        var stateId = el.getAttribute('data-state-id');
        var kind = el.getAttribute('data-state-kind') || '';
        var label = el.getAttribute('data-state-label') || '';
        if (!stateId || !tooltip) return;
        var html = '<span class="tt-state-id">' + stateId + '</span>';
        if (kind) html += '<span class="tt-kind">' + kind + '</span>';
        if (label) html += '<span class="tt-label">' + label + '</span>';
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        var rect = el.getBoundingClientRect();
        tooltip.style.left = (rect.left + rect.width / 2) + 'px';
        tooltip.style.top = (rect.top - 8) + 'px';
        tooltip.style.transform = 'translate(-50%, -100%)';
      });
      el.addEventListener('mouseleave', function() {
        if (tooltip) tooltip.style.display = 'none';
      });
    });

    // ── Trigger bar (source/deployed modes) ──
    document.getElementById('trigger-toggle')?.addEventListener('click', function() {
      var body = document.getElementById('trigger-body');
      var icon = document.getElementById('trigger-icon');
      if (body) {
        var hidden = body.style.display === 'none';
        body.style.display = hidden ? 'flex' : 'none';
        if (icon) icon.textContent = hidden ? '▾' : '▸';
      }
    });

    function buildInputForm(schema, container) {
      container.innerHTML = '';
      if (!schema || schema.length === 0) {
        var ta = document.createElement('textarea');
        ta.id = 'trigger-input';
        ta.className = 'trigger-textarea';
        ta.rows = 3;
        ta.placeholder = '{"key": "value"}';
        ta.textContent = '{}';
        var row = document.createElement('div');
        row.className = 'trigger-row';
        var lbl = document.createElement('label');
        lbl.textContent = 'Input (JSON)';
        row.appendChild(lbl);
        row.appendChild(ta);
        container.appendChild(row);
        return;
      }
      schema.forEach(function(field) {
        var row = document.createElement('div');
        row.className = 'trigger-row';
        var lbl = document.createElement('label');
        lbl.setAttribute('for', 'field-' + field.name);
        lbl.textContent = field.name;
        if (field.optional) lbl.textContent += '?';
        row.appendChild(lbl);
        var input;
        if (field.type === 'boolean') {
          input = document.createElement('select');
          input.innerHTML = '<option value="true">true</option><option value="false" selected>false</option>';
        } else if (field.type === 'number') {
          input = document.createElement('input');
          input.type = 'number';
          input.step = 'any';
          input.placeholder = '0';
        } else if (field.type === 'string') {
          input = document.createElement('input');
          input.type = 'text';
          input.placeholder = field.name;
        } else {
          input = document.createElement('textarea');
          input.rows = 2;
          input.className = 'trigger-textarea';
          input.placeholder = field.type === 'array' ? '[]' : '{}';
        }
        input.id = 'field-' + field.name;
        input.className = input.className || 'trigger-field-input';
        input.setAttribute('data-field-name', field.name);
        input.setAttribute('data-field-type', field.type);
        row.appendChild(input);
        container.appendChild(row);
      });
    }

    function collectFormInput(schema) {
      if (!schema || schema.length === 0) {
        var ta = document.getElementById('trigger-input');
        return ta ? ta.value : '{}';
      }
      var obj = {};
      schema.forEach(function(field) {
        var el = document.getElementById('field-' + field.name);
        if (!el) return;
        var val = el.value;
        if (val === '' && field.optional) return;
        if (field.type === 'number') obj[field.name] = val === '' ? 0 : Number(val);
        else if (field.type === 'boolean') obj[field.name] = val === 'true';
        else if (field.type === 'array' || field.type === 'object' || field.type === 'any') {
          try { obj[field.name] = JSON.parse(val || (field.type === 'array' ? '[]' : '{}')); }
          catch(e) { obj[field.name] = val; }
        } else obj[field.name] = val;
      });
      return JSON.stringify(obj);
    }

    function selectTrigger(idx) {
      selectedTriggerIdx = idx;
      var t = protocolTriggers[idx];
      if (t) {
        currentInputSchema = t.schema;
        currentInputMsgName = t.withType || null;
      } else {
        currentInputSchema = null;
        currentInputMsgName = null;
      }
      var fc = document.getElementById('trigger-fields');
      if (fc) buildInputForm(currentInputSchema, fc);
      var msgLabel = document.getElementById('trigger-msg-label');
      if (msgLabel) msgLabel.textContent = currentInputMsgName ? 'Input: ' + currentInputMsgName : 'Input';
    }

    if (protocolTriggers.length > 0) {
      selectTrigger(0);
    } else {
      var formContainer = document.getElementById('trigger-fields');
      if (formContainer) buildInputForm(currentInputSchema, formContainer);
    }

    var triggerKindSel = document.getElementById('trigger-kind');
    if (triggerKindSel) {
      triggerKindSel.addEventListener('change', function() {
        selectTrigger(parseInt(triggerKindSel.value, 10));
      });
    }

    document.getElementById('trigger-btn')?.addEventListener('click', function() {
      var agentSel = document.getElementById('trigger-agent');
      if (!agentSel) return;
      vscode.postMessage({
        type: 'trigger',
        agentName: agentSel.value,
        protocolName: protoName,
        input: collectFormInput(currentInputSchema),
      });
    });

    document.getElementById('debug-trigger-btn')?.addEventListener('click', function() {
      var agentSel = document.getElementById('trigger-agent');
      if (!agentSel) return;
      vscode.postMessage({
        type: 'debugTrigger',
        agentName: agentSel.value,
        protocolName: protoName,
        input: collectFormInput(currentInputSchema),
        breakpoints: Array.from(breakpointStates),
      });
    });

    // ── Debug mode: lightweight highlight updates ──
    function highlightDebugState(stateId, visited, stepCount) {
      document.querySelectorAll('.debug-active-state').forEach(function(el) {
        el.classList.remove('debug-active-state');
      });
      document.querySelectorAll('.debug-visited-state').forEach(function(el) {
        el.classList.remove('debug-visited-state');
      });
      if (visited) {
        visited.forEach(function(sid) {
          var resolved = resolveStateId(sid);
          var els = document.querySelectorAll('[data-state-id="' + resolved + '"]');
          els.forEach(function(el) { el.classList.add('debug-visited-state'); });
        });
      }
      if (stateId) {
        var resolved = resolveStateId(stateId);
        var els = document.querySelectorAll('[data-state-id="' + resolved + '"]');
        els.forEach(function(el) {
          el.classList.add('debug-active-state');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        var label = document.querySelector('.ctrl-status') || document.querySelector('.debug-status-bar .ctrl-status');
        if (label) {
          var cnt = stepCount || (visited ? visited.length : 0);
          label.innerHTML = 'Paused at <span class="state-name">' + stateId + '</span> <span class="step-count">step ' + cnt + '</span>';
        }
      }
      // Redraw SVG overlay to update arrow colors
      if (typeof window.__seqOverlayRedraw === 'function') window.__seqOverlayRedraw();
    }

    function showDebugError(stateId, agentName, error) {
      document.querySelectorAll('.debug-error-overlay').forEach(function(el) { el.remove(); });
      if (stateId) {
        var resolved = resolveStateId(stateId);
        var els = document.querySelectorAll('[data-state-id="' + resolved + '"]');
        els.forEach(function(el) {
          el.classList.add('debug-error-state');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      var container = document.querySelector('.diagram-container') || document.body;
      var overlay = document.createElement('div');
      overlay.className = 'debug-error-overlay';
      overlay.innerHTML =
        '<span class="error-icon">&#x26A0;</span>' +
        '<span class="error-agent">' + (agentName || 'agent') + '</span>' +
        '<span class="error-at">' + (stateId ? ' at ' + stateId : '') + '</span>' +
        '<pre class="error-message">' + escapeHtml(error || 'Unknown error') + '</pre>' +
        '<button class="error-close" title="Dismiss">&#x2715;</button>';
      overlay.querySelector('.error-close').addEventListener('click', function() { overlay.remove(); });
      container.insertBefore(overlay, container.firstChild);
    }

    function escapeHtml(text) {
      var div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // ── Replay mode: scrubber controls ──
    document.getElementById('replay-scrubber')?.addEventListener('input', function(e) {
      vscode.postMessage({ type: 'replaySeek', position: parseInt(e.target.value, 10) });
    });
    document.getElementById('replay-back')?.addEventListener('click', function() {
      var scrubber = document.getElementById('replay-scrubber');
      if (scrubber) {
        var pos = Math.max(0, parseInt(scrubber.value, 10) - 1);
        scrubber.value = pos;
        vscode.postMessage({ type: 'replaySeek', position: pos });
      }
    });
    document.getElementById('replay-fwd')?.addEventListener('click', function() {
      var scrubber = document.getElementById('replay-scrubber');
      if (scrubber) {
        var pos = Math.min(parseInt(scrubber.max, 10), parseInt(scrubber.value, 10) + 1);
        scrubber.value = pos;
        vscode.postMessage({ type: 'replaySeek', position: pos });
      }
    });
    document.getElementById('replay-close')?.addEventListener('click', function() {
      vscode.postMessage({ type: 'closeReplay' });
    });

    // ── Incoming messages from extension host ──
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'triggerBarUpdate') {
        if (msg.triggers && msg.triggers.length > 0) {
          protocolTriggers = msg.triggers;
          selectTrigger(selectedTriggerIdx < protocolTriggers.length ? selectedTriggerIdx : 0);
        } else if (msg.inputSchema !== undefined) {
          var schemaChanged = JSON.stringify(msg.inputSchema) !== JSON.stringify(currentInputSchema);
          currentInputMsgName = msg.inputMessageName || null;
          if (schemaChanged) {
            currentInputSchema = msg.inputSchema;
            var fc = document.getElementById('trigger-fields');
            if (fc) buildInputForm(currentInputSchema, fc);
          }
          var msgLabel = document.getElementById('trigger-msg-label');
          if (msgLabel) msgLabel.textContent = currentInputMsgName ? 'Input: ' + currentInputMsgName : 'Input';
        }
        updateTriggerBarDom(msg.connected, msg.agents || [], msg.protoName || protoName);
      } else if (msg.type === 'debugStopped') {
        highlightDebugState(msg.stateId, msg.visitedStates, msg.stepCount);
      } else if (msg.type === 'highlightState') {
        highlightDebugState(msg.stateId, null, null);
      } else if (msg.type === 'debugError') {
        showDebugError(msg.stateId, msg.agentName, msg.error);
      } else if (msg.type === 'replaySeek') {
        highlightDebugState(msg.activeStateId, msg.visitedStates, null);
        var posLabel = document.getElementById('replay-pos');
        if (posLabel) posLabel.textContent = (msg.position + 1) + ' / ' + msg.total;
        var scrubber = document.getElementById('replay-scrubber');
        if (scrubber) scrubber.value = msg.position;
      }
    });

    function updateTriggerBarDom(connected, agents, proto) {
      var bar = document.querySelector('.trigger-bar');
      if (!bar) return;
      var statusEl = bar.querySelector('.trigger-status');
      var agentSel = document.getElementById('trigger-agent');
      if (!connected) {
        if (statusEl) { statusEl.textContent = 'not connected'; statusEl.className = 'trigger-status disconnected'; }
        return;
      }
      if (agents.length === 0) {
        if (statusEl) { statusEl.textContent = 'no agents deployed for ' + proto; statusEl.className = 'trigger-status'; }
        if (agentSel) agentSel.innerHTML = '';
        return;
      }
      if (statusEl) { statusEl.textContent = agents.length + ' agent(s)'; statusEl.className = 'trigger-status connected'; }
      if (agentSel) {
        var prev = agentSel.value;
        agentSel.innerHTML = agents.map(function(a) {
          var label = a.name + ' (' + a.role + ' @ ' + a.node + ')';
          return '<option value="' + a.name + '">' + label + '</option>';
        }).join('');
        if (agents.find(function(a) { return a.name === prev; })) agentSel.value = prev;
      }
    }
    `;
  }
}

// ── Utility functions ───────────────────────────────────────────────

/**
 * Build a map from any runtime stateId (across all roles) to the
 * diagram element's stateId (from the initiator's graph).
 *
 * The sequence diagram only contains stateIds from the initiator role.
 * Other roles' states (e.g. buyer's receive for seller's send) need to
 * be aliased so debug highlighting can find the right diagram element.
 *
 * Strategy: collect all send/receive states with their messageName from
 * all graphs. For each message element in the diagram (which has the
 * initiator's stateId), find matching states in other roles and add aliases.
 * Also alias action/timer/etc. states that share the same IR sourceMap line.
 */
function buildStateIdAliasMap(
  seqDiagram: SequenceDiagramData,
  graphs: Map<string, any>,
): Map<string, string> {
  const alias = new Map<string, string>();

  // Collect diagram element stateIds (the "canonical" ones)
  const diagramStateIds = new Set<string>();
  for (const el of seqDiagram.elements) {
    if (el.stateId) diagramStateIds.add(el.stateId);
  }

  // Every diagram stateId is trivially its own alias
  for (const sid of diagramStateIds) {
    alias.set(sid, sid);
  }

  // Collect all send/receive states from all graphs, indexed by messageName+kind
  // Each diagram "message" element comes from either a send or receive in the initiator.
  // The counterpart in another role has a different stateId for the same messageName.
  type MsgState = { stateId: string; role: string; kind: 'send' | 'receive'; messageName: string; to?: string; from?: string };
  const allMsgStates: MsgState[] = [];

  for (const [, graph] of graphs) {
    const g = graph as { role: string; states: Array<{ id: string; data: any }> };
    for (const state of g.states) {
      const d = state.data;
      if (d.kind === 'send') {
        allMsgStates.push({ stateId: state.id, role: g.role, kind: 'send', messageName: d.messageName, to: d.to });
      } else if (d.kind === 'receive') {
        allMsgStates.push({ stateId: state.id, role: g.role, kind: 'receive', messageName: d.messageName, from: d.from });
      }
    }
  }

  // For each diagram message element, find counterpart states
  for (const el of seqDiagram.elements) {
    if (el.kind !== 'message' || !el.stateId) continue;
    const diagramSid = el.stateId;
    const msgName = el.label;
    const from = el.from;
    const to = el.to;

    for (const ms of allMsgStates) {
      if (ms.stateId === diagramSid) continue; // already canonical
      if (ms.messageName !== msgName) continue;
      // Match by message name + participant direction
      if (ms.kind === 'send' && ms.role === from && ms.to === to) {
        alias.set(ms.stateId, diagramSid);
      } else if (ms.kind === 'receive' && ms.role === to && ms.from === from) {
        alias.set(ms.stateId, diagramSid);
      }
    }
  }

  // For action/timer/invoke/spawn: collect non-message states from all graphs
  // and match by stateId substring or sequential position
  // (actions in different roles at the same point won't share IDs, but
  //  each role's action stateId maps to the diagram's action stateId for that role)
  for (const el of seqDiagram.elements) {
    if (el.kind === 'message' || !el.stateId) continue;
    const diagramSid = el.stateId;
    const elRole = el.role;
    const elKind = el.kind;

    for (const [, graph] of graphs) {
      const g = graph as { role: string; states: Array<{ id: string; data: any }> };
      if (g.role !== elRole) continue;
      for (const state of g.states) {
        if (state.id === diagramSid) continue;
        if (state.data.kind === elKind || (elKind === 'action' && state.data.kind === 'action')) {
          // Same role, same kind — map if not already mapped
          if (!alias.has(state.id) && !diagramStateIds.has(state.id)) {
            // Only alias if the state body matches (prevent spurious matches)
            // For now skip non-message aliasing — those should already be in the initiator graph
          }
        }
      }
    }
  }

  return alias;
}

function typeExprToString(te: any): string {
  if (!te) return 'any';
  if (te.kind === 'ScalarType') return te.name;
  if (te.kind === 'AnyType') return 'any';
  if (te.kind === 'ArrayType') return 'array';
  if (te.kind === 'ObjectType') return 'object';
  return 'any';
}

function extractFieldSchemas(fields: any[]): MessageFieldSchema[] {
  return fields.map((f: any) => {
    const schema: MessageFieldSchema = {
      name: f.name,
      type: typeExprToString(f.type),
      optional: f.optional ?? false,
    };
    if (f.type?.kind === 'ArrayType') schema.element = typeExprToString(f.type.element);
    if (f.type?.kind === 'ObjectType' && f.type.fields) schema.fields = extractFieldSchemas(f.type.fields);
    return schema;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function findProjectVersion(filePath: string): string | undefined {
  try {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 6; i++) {
      const rj = path.join(dir, 'reagent.json');
      if (fs.existsSync(rj)) {
        const manifest = JSON.parse(fs.readFileSync(rj, 'utf-8'));
        return manifest.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* non-fatal */ }
  return undefined;
}

function decompileFromSequenceDiagram(data: CompiledData): string {
  const lines: string[] = [];
  const seq = data.sequenceDiagram;
  const proto = data.protocolName;
  const ver = data.version ? ` // v${data.version}` : '';

  lines.push(`// Reconstructed from IR — ${proto}${ver}`);
  lines.push(`// Source: ${data.sourceFile}`);
  lines.push(`// States: ${data.sourceMap.size}  |  Roles: ${data.roles.join(', ')}`);
  lines.push('');

  const participants = seq.participants;
  const initiator = participants.find(p => p.isInitiator)?.name ?? participants[0]?.name ?? '?';

  lines.push(`protocol ${proto} {`);
  const partLine = participants.map(p => `${p.name}${p.lang ? ` [${p.lang}]` : ''}`).join(', ');
  lines.push(`  participants: ${partLine}`);
  lines.push(`  initiator: ${initiator}`);
  if (data.inputMessageName) lines.push(`  input: ${data.inputMessageName}`);
  lines.push('');

  let indent = 1;
  const pad = () => '  '.repeat(indent);

  for (const el of seq.elements) {
    switch (el.kind) {
      case 'action': {
        const stateId = el.stateId ? ` // ${el.stateId}` : '';
        const asyncStr = el.async ? 'await ' : '';
        lines.push(`${pad()}${el.role} {${stateId}`);
        lines.push(`${pad()}  ${asyncStr}${el.label}`);
        lines.push(`${pad()}}`);
        break;
      }
      case 'message': {
        const stateId = el.stateId ? ` // ${el.stateId}` : '';
        lines.push(`${pad()}${el.from} --> ${el.to}: ${el.label}${stateId}`);
        break;
      }
      case 'scatter_start': {
        const coll = el.collection ? ` (${el.collection}` : '';
        const item = el.itemRole ? ` as ${el.itemRole})` : ')';
        lines.push(`${pad()}scatter${coll}${item} {`);
        indent++;
        break;
      }
      case 'scatter_end':
        indent = Math.max(1, indent - 1);
        lines.push(`${pad()}}`);
        break;
      case 'loop_start':
        lines.push(`${pad()}loop${el.condition ? ` [${el.condition}]` : ''} {`);
        indent++;
        break;
      case 'loop_end':
        indent = Math.max(1, indent - 1);
        lines.push(`${pad()}}`);
        break;
      case 'alt_start':
        lines.push(`${pad()}alt${el.condition ? ` [${el.condition}]` : ''} {`);
        indent++;
        break;
      case 'alt_branch':
        lines.push(`${pad()}| ${el.condition ?? 'else'} |`);
        break;
      case 'alt_end':
        indent = Math.max(1, indent - 1);
        lines.push(`${pad()}}`);
        break;
      case 'par_start':
        lines.push(`${pad()}par {`);
        indent++;
        break;
      case 'par_end':
        indent = Math.max(1, indent - 1);
        lines.push(`${pad()}}`);
        break;
      case 'timer':
        lines.push(`${pad()}timer ${el.label}`);
        break;
      case 'invoke': {
        const asyncStr = el.async ? 'async ' : '';
        lines.push(`${pad()}${asyncStr}invoke ${el.label}`);
        break;
      }
      case 'spawn':
        lines.push(`${pad()}spawn ${el.label}`);
        break;
    }
  }

  lines.push('}');
  lines.push('');
  lines.push('// ── Source Map ──');
  for (const [stateId, line] of data.sourceMap) {
    lines.push(`//   ${stateId.padEnd(12)} → line ${line}`);
  }

  return lines.join('\n');
}

function decompileFromIRGraphs(
  irGraphs: Record<string, any>,
  protocolName: string,
  version: string,
): string {
  const lines: string[] = [];
  lines.push(`// ═══════════════════════════════════════════════════════`);
  lines.push(`// Reconstructed from deployed IR on RC`);
  lines.push(`// Protocol: ${protocolName}  v${version}`);
  lines.push(`// IR graphs: ${Object.keys(irGraphs).length}`);
  lines.push(`// ═══════════════════════════════════════════════════════`);
  lines.push('');

  const graphEntries = Object.entries(irGraphs);
  const roles = graphEntries.map(([, g]) => (g as any).role as string).filter(Boolean);
  const uniqueRoles = [...new Set(roles)];

  lines.push(`protocol ${protocolName} {`);
  if (uniqueRoles.length) lines.push(`  roles: ${uniqueRoles.join(', ')}`);
  const initiator = graphEntries.find(([, g]) => (g as any).initiator)?.[1]?.initiator;
  if (initiator) lines.push(`  initiator: ${initiator}`);
  lines.push('}');
  lines.push('');

  for (const [graphKey, graph] of graphEntries) {
    const g = graph as {
      protocolName: string; role: string; lang: string;
      states: Array<{ id: string; kind: string; data: any }>;
      transitions: Array<{ from: string; to: string; label: any }>;
      initialStateId: string; terminalStateIds: string[];
    };

    lines.push(`// ── ${g.role} (${g.lang}) ── key: ${graphKey}`);
    lines.push(`//    states: ${g.states.length}  transitions: ${g.transitions.length}`);
    lines.push(`//    initial: ${g.initialStateId}  terminal: [${g.terminalStateIds.join(', ')}]`);
    lines.push('');

    const stateMap = new Map(g.states.map(s => [s.id, s]));
    const transFromMap = new Map<string, typeof g.transitions>();
    for (const t of g.transitions) {
      const arr = transFromMap.get(t.from) || [];
      arr.push(t);
      transFromMap.set(t.from, arr);
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; indent: number }> = [{ id: g.initialStateId, indent: 1 }];

    while (queue.length > 0) {
      const { id, indent } = queue.shift()!;
      if (visited.has(id)) {
        lines.push(`${'  '.repeat(indent)}// → (back to ${id})`);
        continue;
      }
      visited.add(id);
      const state = stateMap.get(id);
      if (!state) continue;

      const p = '  '.repeat(indent);
      const d = state.data || {};

      switch (state.kind) {
        case 'initial': lines.push(`${p}// [${id}] initial`); break;
        case 'send':
          lines.push(`${p}${g.role} --> ${d.to}: ${d.messageName}  // [${id}]`);
          if (d.preSendZone) lines.push(`${p}  zone { ${truncate(d.preSendZone, 60)} }`);
          break;
        case 'receive':
          lines.push(`${p}${d.from} --> ${g.role}: ${d.messageName}  // [${id}]`);
          if (d.postReceiveZone) lines.push(`${p}  zone { ${truncate(d.postReceiveZone, 60)} }`);
          break;
        case 'action':
          lines.push(`${p}${g.role} {  // [${id}]`);
          lines.push(`${p}  ${truncate(d.body || '', 80)}`);
          lines.push(`${p}}`);
          break;
        case 'guard': lines.push(`${p}guard [${d.guardType}]${d.expr ? ` ${truncate(d.expr, 40)}` : ''}  // [${id}]`); break;
        case 'fork': lines.push(`${p}fork  // [${id}] branches: ${(d.branchStartIds || []).length}`); break;
        case 'join': lines.push(`${p}join  // [${id}]`); break;
        case 'scatter': lines.push(`${p}scatter ${d.collection} as ${d.itemRole} {  // [${id}]`); break;
        case 'timer': lines.push(`${p}timer ${d.duration?.value ?? '?'}${d.duration?.unit ?? '?'}  // [${id}]`); break;
        case 'invoke': lines.push(`${p}invoke ${d.protocolName}(${truncate(d.input || '', 30)})  // [${id}]`); break;
        case 'spawn': lines.push(`${p}spawn ${d.protocolName}(${truncate(d.input || '', 30)})  // [${id}]`); break;
        case 'terminal': lines.push(`${p}// [${id}] terminal (${d.status})`); break;
        case 'error': lines.push(`${p}// [${id}] error: ${d.label || '?'}`); break;
        default: lines.push(`${p}// [${id}] ${state.kind}`);
      }

      const outgoing = transFromMap.get(id) || [];
      for (const t of outgoing) {
        const lbl = t.label;
        if (lbl.kind === 'default') {
          queue.push({ id: t.to, indent });
        } else if (lbl.kind === 'branch') {
          lines.push(`${p}  // branch ${lbl.branchIndex} →`);
          queue.push({ id: t.to, indent: indent + 1 });
        } else if (lbl.kind === 'message') {
          lines.push(`${p}  // on ${lbl.messageName} →`);
          queue.push({ id: t.to, indent });
        } else if (lbl.kind === 'expression') {
          lines.push(`${p}  // when ${truncate(lbl.expr || '', 40)} →`);
          queue.push({ id: t.to, indent });
        } else if (lbl.kind === 'timeout') {
          lines.push(`${p}  // timeout →`);
          queue.push({ id: t.to, indent });
        } else if (lbl.kind === 'else') {
          lines.push(`${p}  // else →`);
          queue.push({ id: t.to, indent });
        } else if (lbl.kind === 'error') {
          lines.push(`${p}  // error →`);
          queue.push({ id: t.to, indent });
        } else {
          queue.push({ id: t.to, indent });
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\n/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 3) + '...' : clean;
}

// ── Base styles ─────────────────────────────────────────────────────

function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-foreground, #d4d4d4);
      overflow: hidden; height: 100vh;
      display: flex; flex-direction: column;
    }

    /* ── Mode badge ── */
    .mode-badge {
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 1px 6px; border-radius: 3px; margin-left: 4px;
      text-transform: uppercase;
    }
    .mode-badge-idle { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #ccc); }
    .mode-badge-source { background: rgba(79, 193, 255, 0.15); color: var(--vscode-charts-blue, #4fc1ff); border: 1px solid rgba(79, 193, 255, 0.3); }
    .mode-badge-deployed { background: rgba(177, 128, 215, 0.15); color: var(--vscode-charts-purple, #b180d7); border: 1px solid rgba(177, 128, 215, 0.3); }
    .mode-badge-debug { background: rgba(137, 209, 133, 0.15); color: var(--vscode-debugIcon-startForeground, #89d185); border: 1px solid rgba(137, 209, 133, 0.3); animation: pulse-badge 1.5s ease-in-out infinite; }
    .mode-badge-replay { background: rgba(209, 134, 22, 0.15); color: var(--vscode-charts-orange, #d18616); border: 1px solid rgba(209, 134, 22, 0.3); }
    @keyframes pulse-badge { 0%,100%{opacity:1} 50%{opacity:0.6} }

    /* ── Idle placeholder ── */
    .idle-placeholder {
      color: var(--vscode-descriptionForeground, #888);
      padding: 60px 40px; text-align: center; font-size: 14px;
    }
    .idle-placeholder code {
      background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
    }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      background: var(--vscode-sideBar-background, #252526);
      gap: 8px; flex-shrink: 0;
    }
    .toolbar-left, .toolbar-center, .toolbar-right { display: flex; align-items: center; gap: 6px; }
    .proto-name { font-weight: 600; font-size: 13px; }
    .version-tag { font-size: 10px; color: var(--vscode-descriptionForeground, #888); background: var(--vscode-badge-background, #4d4d4d); padding: 1px 6px; border-radius: 8px; }
    .toolbar-select {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, #555);
      border-radius: 3px; padding: 3px 6px; font-size: 12px; cursor: pointer;
    }
    .tab {
      background: transparent; border: none;
      color: var(--vscode-foreground, #ccc);
      padding: 4px 12px; cursor: pointer; font-size: 12px;
      border-radius: 3px; transition: background 0.1s;
    }
    .tab:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .tab.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }

    /* ── Diagram container ── */
    .diagram-container {
      flex: 1; padding: 16px; overflow: auto;
      display: flex; align-items: flex-start; justify-content: center;
    }
    .diagram-container svg { width: 100%; max-width: 800px; }
    .diagram-container .seq-diagram { max-width: 800px; }

    /* ── Trigger bar ── */
    .trigger-bar { border-bottom: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-sideBar-background, #252526); flex-shrink: 0; }
    .trigger-header {
      padding: 5px 12px; cursor: pointer; font-size: 12px;
      display: flex; align-items: center; gap: 6px; user-select: none;
    }
    .trigger-header:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .trigger-status { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-left: auto; }
    .trigger-status.connected { color: var(--vscode-testing-iconPassed, #73c991); }
    .trigger-status.disconnected { color: var(--vscode-testing-iconFailed, #f48771); }
    .trigger-body { display: none; flex-direction: column; gap: 6px; padding: 6px 12px 10px; }
    .trigger-row { display: flex; align-items: center; gap: 8px; }
    .trigger-row label { font-size: 11px; min-width: 40px; color: var(--vscode-descriptionForeground, #888); }
    .trigger-select {
      flex: 1; background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ccc);
      border: 1px solid var(--vscode-dropdown-border, #555);
      border-radius: 3px; padding: 3px 6px; font-size: 12px;
    }
    .trigger-textarea {
      flex: 1; background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px; padding: 4px 6px;
      font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; resize: vertical;
    }
    .trigger-section-label { font-size: 11px; color: var(--vscode-descriptionForeground, #888); padding: 4px 0 2px; border-top: 1px solid var(--vscode-panel-border, #333); margin-top: 4px; }
    .trigger-fields { display: flex; flex-direction: column; gap: 4px; }
    .trigger-field-input {
      flex: 1; background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px; padding: 3px 6px; font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .trigger-field-input:focus, .trigger-textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); outline: none; }
    .trigger-actions { display: flex; gap: 6px; margin-top: 4px; }
    .trigger-button {
      padding: 4px 16px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 3px; cursor: pointer; font-size: 12px;
      transition: background 0.1s;
    }
    .trigger-button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .trigger-button.debug-button { background: var(--vscode-debugIcon-startForeground, #89d185); color: #1a1a1a; font-weight: 600; }
    .trigger-button.debug-button:hover { opacity: 0.85; }

    /* ── Debug status bar ── */
    .debug-status-bar {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 12px;
      background: color-mix(in srgb, var(--vscode-debugIcon-startForeground, #89d185) 8%, var(--vscode-sideBar-background, #252526));
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-debugIcon-startForeground, #89d185) 25%, var(--vscode-panel-border, #333));
      flex-shrink: 0; font-size: 11px;
    }
    .debug-status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-debugIcon-startForeground, #89d185);
      animation: pulse-dot 1.5s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .ctrl-status {
      font-size: 11px; color: var(--vscode-descriptionForeground, #888);
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ctrl-status .state-name { color: var(--vscode-debugIcon-startForeground, #89d185); font-weight: 600; }
    .ctrl-status .step-count { color: var(--vscode-descriptionForeground, #888); font-size: 10px; margin-left: 4px; }

    /* ── Replay bar ── */
    .replay-bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 6px 12px;
      background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 6%, var(--vscode-sideBar-background, #252526));
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-charts-orange, #d18616) 25%, var(--vscode-panel-border, #333));
      flex-shrink: 0; font-size: 11px;
    }
    .replay-badge {
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 2px 8px; border-radius: 3px;
    }
    .replay-completed { background: rgba(137, 209, 133, 0.15); color: var(--vscode-debugIcon-startForeground, #89d185); }
    .replay-failed { background: rgba(244, 71, 71, 0.15); color: var(--vscode-errorForeground, #f44747); }
    .replay-stopped { background: rgba(204, 167, 0, 0.15); color: var(--vscode-charts-yellow, #cca700); }
    .replay-info { color: var(--vscode-descriptionForeground, #888); }
    .replay-error-hint { color: var(--vscode-errorForeground, #f48771); font-size: 10px; flex: 1 1 100%; }
    .replay-controls {
      display: flex; align-items: center; gap: 4px; flex: 1 1 100%; margin-top: 2px;
    }
    .replay-btn {
      background: transparent; border: 1px solid var(--vscode-panel-border, #444);
      color: var(--vscode-foreground, #ccc); border-radius: 3px;
      width: 24px; height: 22px; cursor: pointer; font-size: 10px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .replay-btn:hover { background: rgba(255,255,255,0.06); }
    .replay-scrubber {
      flex: 1; height: 4px; cursor: pointer;
      -webkit-appearance: none; appearance: none;
      background: var(--vscode-panel-border, #444); border-radius: 2px;
    }
    .replay-scrubber::-webkit-slider-thumb {
      -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
      background: var(--vscode-charts-orange, #d18616); cursor: pointer;
    }
    .replay-position { font-size: 10px; color: var(--vscode-descriptionForeground, #888); min-width: 55px; text-align: right; }
    .replay-close-btn {
      background: transparent; border: 1px solid var(--vscode-panel-border, #444);
      color: var(--vscode-descriptionForeground, #888); border-radius: 3px;
      padding: 2px 8px; cursor: pointer; font-size: 10px; margin-left: auto;
    }
    .replay-close-btn:hover { background: rgba(255,255,255,0.06); color: var(--vscode-foreground, #ccc); }

    /* ── Protocol info bar ── */
    .proto-info-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 3px 12px;
      background: var(--vscode-sideBar-background, #252526);
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      font-size: 11px; flex-shrink: 0;
    }
    .proto-info-item { color: var(--vscode-foreground, #d4d4d4); }
    .proto-info-version {
      color: var(--vscode-debugIcon-startForeground, #89d185);
      font-weight: 600; font-size: 11px;
    }
    .info-label {
      color: var(--vscode-descriptionForeground, #888);
      margin-right: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .proto-info-sep { width: 1px; height: 12px; background: var(--vscode-panel-border, #444); }
    .toolbar-icon-btn {
      background: transparent; border: 1px solid transparent;
      color: var(--vscode-descriptionForeground, #888);
      border-radius: 3px; width: 24px; height: 22px;
      cursor: pointer; font-size: 13px;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0; transition: background 0.1s;
    }
    .toolbar-icon-btn:hover { background: rgba(255,255,255,0.08); border-color: var(--vscode-panel-border, #333); color: var(--vscode-foreground, #d4d4d4); }

    /* ── Debug state highlighting (postMessage-driven) ── */
    .debug-active-state {
      outline: 2px solid var(--vscode-debugIcon-startForeground, #89d185) !important;
      outline-offset: 2px;
      background: rgba(137, 209, 133, 0.12) !important;
      border-radius: 6px;
      z-index: 2;
      position: relative;
    }
    .debug-visited-state { opacity: 1 !important; }
    .debug-visited-state .msg-label,
    .debug-visited-state .action-pill,
    .debug-visited-state .timer-pill,
    .debug-visited-state .invoke-pill,
    .debug-visited-state .spawn-pill { opacity: 0.35; }
    .debug-visited-state rect, .debug-visited-state ellipse { fill-opacity: 0.3; stroke: var(--vscode-debugIcon-startForeground, #89d185) !important; }

    .debug-breakpoint { position: relative; }
    .debug-breakpoint::after { content: ''; position: absolute; left: -6px; top: 50%; transform: translateY(-50%); width: 10px; height: 10px; background: var(--vscode-debugIcon-breakpointForeground, #e51400); border-radius: 50%; pointer-events: none; }
    [data-state-id].debug-breakpoint > rect, [data-state-id].debug-breakpoint > polygon, [data-state-id].debug-breakpoint > circle { stroke: var(--vscode-debugIcon-breakpointForeground, #e51400) !important; stroke-width: 2.5; }

    .debug-error-state {
      outline: 3px solid var(--vscode-errorForeground, #f44747) !important;
      outline-offset: 2px;
      animation: error-pulse 1.5s ease-in-out infinite;
    }
    .debug-error-state rect, .debug-error-state ellipse, .debug-error-state polygon {
      fill: rgba(244, 71, 71, 0.15) !important;
      stroke: var(--vscode-errorForeground, #f44747) !important;
      stroke-width: 2.5;
    }
    @keyframes error-pulse {
      0%, 100% { outline-color: var(--vscode-errorForeground, #f44747); }
      50% { outline-color: rgba(244, 71, 71, 0.3); }
    }

    .debug-error-overlay {
      display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;
      padding: 8px 14px;
      margin: 4px 0;
      background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 12%, var(--vscode-editor-background, #1e1e1e));
      border: 1px solid var(--vscode-errorForeground, #f44747);
      border-radius: 6px;
      font-size: 12px;
      color: var(--vscode-foreground, #d4d4d4);
      position: relative;
    }
    .debug-error-overlay .error-icon { font-size: 16px; color: var(--vscode-errorForeground, #f44747); flex-shrink: 0; line-height: 1; }
    .debug-error-overlay .error-agent { font-weight: 600; color: var(--vscode-errorForeground, #f44747); }
    .debug-error-overlay .error-at { color: var(--vscode-descriptionForeground, #888); margin-right: 4px; }
    .debug-error-overlay .error-message {
      flex: 1 1 100%; margin: 4px 0 0 24px; padding: 6px 10px;
      background: rgba(0,0,0,0.25); border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
      white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto;
      color: var(--vscode-errorForeground, #f44747);
    }
    .debug-error-overlay .error-close {
      position: absolute; top: 4px; right: 6px;
      background: transparent; border: none; color: var(--vscode-descriptionForeground, #888);
      cursor: pointer; font-size: 14px; padding: 2px 4px; line-height: 1;
    }
    .debug-error-overlay .error-close:hover { color: var(--vscode-foreground, #d4d4d4); }
    .error-badge {
      display: inline-block;
      background: var(--vscode-errorForeground, #f44747);
      color: #fff;
      font-size: 10px; font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      letter-spacing: 0.5px;
    }

    /* ── Tooltip ── */
    .diagram-tooltip {
      display: none; position: fixed;
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 4px; padding: 6px 10px;
      font-size: 11px; font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground, #d4d4d4);
      max-width: 350px; white-space: pre; overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4); z-index: 1000; pointer-events: none;
    }
    .diagram-tooltip .tt-state-id { color: var(--vscode-debugIcon-startForeground, #89d185); font-weight: 600; }
    .diagram-tooltip .tt-kind { color: var(--vscode-descriptionForeground, #888); margin-left: 6px; }
    .diagram-tooltip .tt-label { display: block; margin-top: 4px; color: var(--vscode-charts-purple, #b180d7); }

    /* ── Mode-specific body styles ── */
    body[data-mode="debug"] .diagram-container { border-top: 2px solid rgba(137, 209, 133, 0.2); }
    body[data-mode="replay"] .diagram-container { border-top: 2px solid rgba(209, 134, 22, 0.2); }
  `;
}
