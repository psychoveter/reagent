import * as vscode from 'vscode';
import * as path from 'path';
import {
  renderSequenceDiagram,
  SEQUENCE_DIAGRAM_CSS,
  type SequenceDiagramData,
} from './renderers/sequenceDiagram';
import {
  renderStateMachineDiagram,
  STATE_MACHINE_CSS,
  type StateMachineDiagramData,
} from './renderers/stateMachineDiagram';
import type { ClusterPanelProvider } from './clusterPanel';
import { ReagentDebugSession } from './reagentDebugAdapter';

type ViewMode = 'sequence' | 'statemachine';

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
}

interface MessageFieldSchema {
  name: string;
  type: string; // "string" | "number" | "boolean" | "any" | "array" | "object"
  optional: boolean;
  element?: string; // for arrays
  fields?: MessageFieldSchema[]; // for objects
}

interface CompiledData {
  protocolName: string;
  version?: string;
  sequenceDiagram: SequenceDiagramData;
  stateMachines: Map<string, StateMachineDiagramData>;
  sourceFile: string;
  sourceMap: Map<string, number>;
  roles: string[];
  inputMessageSchema: MessageFieldSchema[] | null;
  inputMessageName: string | null;
}

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

export class ReagentDiagramPanel {
  public static readonly viewType = 'reagentDiagram';
  private static instance: ReagentDiagramPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private viewMode: ViewMode = 'sequence';
  private selectedRole = '';
  private disposables: vscode.Disposable[] = [];
  private compiledData: CompiledData | null = null;
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private clusterPanel: ClusterPanelProvider | null = null;

  private debugSessionId: string | null = null;
  private debugVisitedStates = new Set<string>();
  private debugActiveState: string | null = null;
  private stoppedListener: vscode.Disposable | null = null;

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
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: DiagramMessage) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // Watch active .rg editor and auto-compile
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.languageId === 'reagent') {
          this.compileAndRender(editor.document);
        }
      }),
    );

    // Recompile on save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'reagent') {
          this.compileAndRender(doc);
        }
      }),
    );

    // Update trigger bar when cluster state changes (lightweight postMessage, not full re-render)
    if (this.clusterPanel) {
      this.disposables.push(
        this.clusterPanel.onDidChangeTreeData(() => this.updateTriggerBar()),
      );
    }

    // Listen for Stopped events from the RAP connection (cluster debug)
    this.listenForStoppedEvents();

    // When a DAP debug session ends, also end cluster debug mode in the webview
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession(session => {
        if (session.type === 'reagent' && this.debugSessionId) {
          this.debugSessionId = null;
          this.debugActiveState = null;
          this.panel.webview.postMessage({ type: 'debugSessionEnded' });
        }
      }),
    );

    // Try to compile the currently active .rg file
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'reagent') {
      this.compileAndRender(editor.document);
    } else {
      this.render();
    }
  }

  /** Called externally to update diagram with debug state */
  public updateDebug(activeStateId?: string, visitedStateIds?: Set<string>): void {
    this.render({ activeStateId, visitedStateIds });
  }

  /** Called externally to highlight a specific state */
  public highlightState(stateId: string): void {
    this.panel.webview.postMessage({ type: 'highlightState', stateId });
  }

  private async compileAndRender(document: vscode.TextDocument): Promise<void> {
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
        const key = `${proto.name}.${role}`;
        graphs.set(key, graph);
        roles.push(role);
      }

      const sourceMap = new Map<string, number>();
      for (const entry of result.sourceMap ?? []) {
        if (entry.line != null) {
          sourceMap.set(entry.stateId, entry.line);
        }
      }

      const seqDiagram = compiler.buildSequenceDiagram(graphs, proto.name);
      const stateMachines = new Map<string, StateMachineDiagramData>();
      for (const [, graph] of graphs) {
        const sm = compiler.buildStateMachineDiagram(graph);
        stateMachines.set(sm.role, sm);
      }

      // Extract input message schema from AST
      const inputTypeName = proto.input ?? null;
      let inputMessageSchema: MessageFieldSchema[] | null = null;
      if (inputTypeName) {
        const messageDefs = items.filter((i: any) => i.kind === 'MessageDef');
        const inputDef = messageDefs.find((m: any) => m.name === inputTypeName);
        if (inputDef) {
          inputMessageSchema = extractFieldSchemas(inputDef.fields ?? []);
        }
      }

      this.compiledData = {
        protocolName: proto.name,
        version: seqDiagram.version,
        sequenceDiagram: seqDiagram,
        stateMachines,
        sourceFile: document.uri.fsPath,
        sourceMap,
        roles,
        inputMessageSchema,
        inputMessageName: inputTypeName,
      };

      if (!this.selectedRole || !roles.includes(this.selectedRole)) {
        this.selectedRole = roles[0] ?? '';
      }

      this.render();
    } catch (err) {
      this.renderError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private renderError(message: string): void {
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family, monospace); background: var(--vscode-editor-background, #1e1e1e);
         color: var(--vscode-errorForeground, #f48771); padding: 24px; white-space: pre-wrap; }
</style></head><body>${esc(message)}</body></html>`;
  }

  private handleMessage(msg: DiagramMessage): void {
    switch (msg.type) {
      case 'switchView':
        this.viewMode = this.viewMode === 'sequence' ? 'statemachine' : 'sequence';
        this.render();
        break;
      case 'selectRole':
        if (msg.role) {
          this.selectedRole = msg.role;
          this.render();
        }
        break;
      case 'clickNode':
        if (msg.line && msg.file) {
          this.revealSource(msg.file, msg.line);
        }
        break;
      case 'trigger':
        this.handleTrigger(msg);
        break;
      case 'debugTrigger':
        this.handleDebugTrigger(msg);
        break;
      case 'debugAction':
        this.handleDebugAction(msg);
        break;
    }
  }

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
      payload: {
        agentName: msg.agentName,
        protocolName: msg.protocolName,
        input,
      },
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

    const sessionId = `dbg-${Date.now().toString(36)}`;
    this.debugSessionId = sessionId;
    this.debugVisitedStates.clear();
    this.debugActiveState = null;

    const breakpoints = msg.breakpoints ?? [];

    rap.send({
      rap: 'TriggerOnCluster',
      payload: {
        agentName: msg.agentName,
        protocolName: msg.protocolName,
        input,
        mode: 'debug',
        sessionId,
        breakpoints,
      },
    });

    this.panel.webview.postMessage({
      type: 'debugSessionStarted',
      sessionId,
    });

    // Also start a DAP debug session so VS Code debug UI (breakpoints, variables, stack) works.
    // The DAP session attaches to the existing cluster debug via the shared RAP connection.
    const rgFile = this.compiledData?.sourceFile || '';
    ReagentDebugSession.pendingClusterRap = rap;

    // Pass source map from the diagram's compile to the DAP session
    if (this.compiledData?.sourceMap) {
      const entries: Array<{ stateId: string; protocolName: string; role: string; file: string; line: number; column: number }> = [];
      for (const [stateId, line] of this.compiledData.sourceMap) {
        entries.push({
          stateId,
          protocolName: this.compiledData.protocolName,
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

  private handleDebugAction(msg: DiagramMessage): void {
    const rap = this.clusterPanel?.getRapClient();
    if (!rap?.connected || !this.debugSessionId) return;
    const command = msg.command;
    if (!command) return;

    rap.send({
      rap: 'DebugCommand',
      payload: {
        sessionId: this.debugSessionId,
        command,
      },
    });

    if (command === 'stop') {
      // Terminate the VS Code debug session — this will fire onDidTerminateDebugSession
      // which cleans up debugSessionId and sends debugSessionEnded to webview.
      vscode.debug.stopDebugging();
    }
  }

  private listenForStoppedEvents(): void {
    this.ensureStoppedListener();
    // Re-attach when cluster reconnects
    if (this.clusterPanel) {
      this.disposables.push(
        this.clusterPanel.onDidChangeTreeData(() => this.ensureStoppedListener()),
      );
    }
  }

  private ensureStoppedListener(): void {
    const rap = this.clusterPanel?.getRapClient();
    if (!rap) return;

    // Dispose previous listener to avoid duplicates
    this.stoppedListener?.dispose();

    this.stoppedListener = rap.on('Stopped', (msg) => {
      if (!this.debugSessionId) return;
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const sessionId = payload.sessionId as string;
      if (sessionId && sessionId !== this.debugSessionId) return;

      const stateId = payload.stateId as string | undefined;
      const stateKind = payload.stateKind as string | undefined;
      const agentName = payload.agentName as string | undefined;
      const reason = payload.reason as string | undefined;

      if (stateId) {
        this.debugActiveState = stateId;
        this.debugVisitedStates.add(stateId);
      }

      this.panel.webview.postMessage({
        type: 'debugStopped',
        stateId,
        stateKind,
        agentName,
        reason,
        visitedStates: [...this.debugVisitedStates],
      });
    });
    this.disposables.push(this.stoppedListener);
  }

  private revealSource(file: string, line: number): void {
    const uri = vscode.Uri.file(file);
    vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line - 1, 0, line - 1, 0),
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private dispose(): void {
    ReagentDiagramPanel.instance = undefined;
    this.panel.dispose();
    if (this.fileWatcher) this.fileWatcher.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private render(debug?: { activeStateId?: string; visitedStateIds?: Set<string> }): void {
    const isSeq = this.viewMode === 'sequence';
    const protoLabel = this.compiledData?.protocolName ?? 'Protocol';
    this.panel.title = `${protoLabel} — ${isSeq ? 'Sequence' : 'State Machine'}`;
    this.panel.webview.html = this.getHtml(debug);
  }

  /**
   * Lightweight trigger bar update via postMessage — avoids full webview HTML rebuild
   * which would reset scroll position, expanded state, and input text.
   */
  private updateTriggerBar(): void {
    const connected = this.isClusterConnected();
    const agents = this.getClusterAgentsForProtocol(true);
    const protoName = this.compiledData?.protocolName ?? '(no protocol)';
    this.panel.webview.postMessage({
      type: 'triggerBarUpdate',
      connected,
      agents,
      protoName,
      inputSchema: this.compiledData?.inputMessageSchema ?? null,
      inputMessageName: this.compiledData?.inputMessageName ?? null,
    });
  }

  private getClusterAgentsForProtocol(initiatorsOnly: boolean): Array<{ name: string; role: string; node: string }> {
    if (!this.clusterPanel || !this.compiledData) return [];
    const state = this.clusterPanel.getState();
    const protoName = this.compiledData.protocolName;

    // Primary: agents that have protocolName set
    let agents = state.agents.filter(a => a.protocolName === protoName);

    // Fallback: if no direct matches, cross-reference with protocols.boundAgents
    if (agents.length === 0) {
      const proto = state.protocols.find(p => p.name === protoName);
      if (proto && proto.boundAgents.length > 0) {
        const bound = new Set(proto.boundAgents);
        agents = state.agents.filter(a => bound.has(a.agentName));
      }
    }

    // Fallback 2: if agents have empty protocolName, match by roleName against diagram roles
    if (agents.length === 0) {
      const diagramRoles = new Set(this.compiledData.roles);
      agents = state.agents.filter(a => diagramRoles.has(a.roleName));
    }

    if (initiatorsOnly) {
      const initiatorRoles = new Set(
        this.compiledData.sequenceDiagram.participants
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

  private isClusterConnected(): boolean {
    return !!this.clusterPanel?.getRapClient()?.connected;
  }

  private getHtml(debug?: { activeStateId?: string; visitedStateIds?: Set<string> }): string {
    const isSeq = this.viewMode === 'sequence';
    const data = this.compiledData;
    const protoName = data?.protocolName ?? '(no protocol)';
    const roles = data?.roles ?? [];

    let diagramSvg = '<div style="color:#888;padding:40px">Open a .rg file to see the diagram</div>';

    if (data) {
      const renderOpts = {
        sourceFile: data.sourceFile,
        sourceMap: data.sourceMap,
        debug,
      };

      if (isSeq) {
        diagramSvg = renderSequenceDiagram(data.sequenceDiagram, renderOpts);
      } else {
        const sm = data.stateMachines.get(this.selectedRole);
        if (sm) {
          diagramSvg = renderStateMachineDiagram(sm, renderOpts);
        } else {
          diagramSvg = '<div style="color:#888;padding:40px">Select a role</div>';
        }
      }
    }

    const clusterAgents = this.getClusterAgentsForProtocol(true);
    const connected = this.isClusterConnected();
    const agentsJson = JSON.stringify(clusterAgents);
    const inputSchemaJson = JSON.stringify(data?.inputMessageSchema ?? null);
    const inputMsgName = data?.inputMessageName ?? null;

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
<body>
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="proto-name">${esc(protoName)}</span>
      ${data?.version ? `<span class="version-tag">v${esc(data.version)}</span>` : ''}
    </div>
    <div class="toolbar-center">
      <button class="tab ${isSeq ? 'active' : ''}" id="btn-seq">Sequence</button>
      <button class="tab ${!isSeq ? 'active' : ''}" id="btn-sm">State Machine</button>
    </div>
    <div class="toolbar-right">
      ${!isSeq ? `<select id="role-select" class="toolbar-select">
        ${roles.map(r => `<option value="${esc(r)}" ${this.selectedRole === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select>` : ''}
    </div>
  </div>
  ${data ? this.getTriggerBarHtml(protoName, connected, clusterAgents) : ''}
  <div class="diagram-container">
    ${diagramSvg}
  </div>
  <div class="diagram-tooltip" id="diagram-tooltip"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const clusterAgents = ${agentsJson};
    const protoName = ${JSON.stringify(protoName)};
    let currentInputSchema = ${inputSchemaJson};
    let currentInputMsgName = ${JSON.stringify(inputMsgName)};

    document.getElementById('btn-seq')?.addEventListener('click', () => vscode.postMessage({ type: 'switchView' }));
    document.getElementById('btn-sm')?.addEventListener('click', () => vscode.postMessage({ type: 'switchView' }));
    document.getElementById('role-select')?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'selectRole', role: e.target.value });
    });
    // Breakpoint state IDs (toggled by clicking states)
    var breakpointStates = new Set();

    document.querySelectorAll('[data-state-id]').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        var stateId = el.getAttribute('data-state-id');
        if (!stateId) return;

        // If shift-click or right area, toggle breakpoint
        if (e.shiftKey || e.altKey) {
          if (breakpointStates.has(stateId)) {
            breakpointStates.delete(stateId);
            el.classList.remove('debug-breakpoint');
          } else {
            breakpointStates.add(stateId);
            el.classList.add('debug-breakpoint');
          }
          e.stopPropagation();
          return;
        }

        // Normal click: navigate to source
        var line = parseInt(el.getAttribute('data-src-line'), 10);
        var file = el.getAttribute('data-src-file');
        if (line && file) vscode.postMessage({ type: 'clickNode', line, file });
      });
    });

    // Tooltip on diagram node hover
    var tooltip = document.getElementById('diagram-tooltip');
    document.querySelectorAll('[data-state-id]').forEach(function(el) {
      el.addEventListener('mouseenter', function(e) {
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

    // Trigger bar toggle
    document.getElementById('trigger-toggle')?.addEventListener('click', () => {
      const body = document.getElementById('trigger-body');
      const icon = document.getElementById('trigger-icon');
      if (body) {
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'flex' : 'none';
        if (icon) icon.textContent = hidden ? '▾' : '▸';
      }
    });

    // Build form fields from schema
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

    // Collect form values into JSON
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
        if (field.type === 'number') {
          obj[field.name] = val === '' ? 0 : Number(val);
        } else if (field.type === 'boolean') {
          obj[field.name] = val === 'true';
        } else if (field.type === 'array' || field.type === 'object' || field.type === 'any') {
          try { obj[field.name] = JSON.parse(val || (field.type === 'array' ? '[]' : '{}')); }
          catch(e) { obj[field.name] = val; }
        } else {
          obj[field.name] = val;
        }
      });
      return JSON.stringify(obj);
    }

    // Initialize form
    var formContainer = document.getElementById('trigger-fields');
    if (formContainer) buildInputForm(currentInputSchema, formContainer);

    // Trigger action
    document.getElementById('trigger-btn')?.addEventListener('click', () => {
      const agentSel = document.getElementById('trigger-agent');
      if (!agentSel) return;
      vscode.postMessage({
        type: 'trigger',
        agentName: agentSel.value,
        protocolName: protoName,
        input: collectFormInput(currentInputSchema),
      });
    });

    // Debug trigger action
    document.getElementById('debug-trigger-btn')?.addEventListener('click', () => {
      const agentSel = document.getElementById('trigger-agent');
      if (!agentSel) return;
      vscode.postMessage({
        type: 'debugTrigger',
        agentName: agentSel.value,
        protocolName: protoName,
        input: collectFormInput(currentInputSchema),
        breakpoints: Array.from(breakpointStates),
      });
    });

    // Debug toolbar buttons
    ['step', 'step-over', 'step-into', 'continue', 'stop', 'restart'].forEach(function(action) {
      var btn = document.getElementById('debug-' + action);
      if (btn) {
        var commandMap = { 'step': 'stepState', 'step-over': 'stepOver', 'step-into': 'stepIn', 'continue': 'continue', 'stop': 'stop', 'restart': 'restart' };
        btn.addEventListener('click', function() {
          vscode.postMessage({ type: 'debugAction', command: commandMap[action] });
        });
      }
    });

    // Debug state tracking
    var debugActive = false;
    var visitedStates = {};

    function setDebugMode(active) {
      debugActive = active;
      var toolbar = document.getElementById('debug-toolbar');
      var triggerBody = document.getElementById('trigger-body');
      if (toolbar) toolbar.style.display = active ? 'flex' : 'none';
      if (active && triggerBody) triggerBody.style.display = 'none';
    }

    function highlightDebugState(stateId, visited) {
      // Clear previous highlights
      document.querySelectorAll('.debug-active-state').forEach(function(el) {
        el.classList.remove('debug-active-state');
      });
      document.querySelectorAll('.debug-visited-state').forEach(function(el) {
        el.classList.remove('debug-visited-state');
      });
      // Mark visited
      if (visited) {
        visited.forEach(function(sid) {
          var el = document.getElementById(sid) || document.querySelector('[data-state-id="' + sid + '"]');
          if (el) el.classList.add('debug-visited-state');
        });
      }
      // Mark active
      if (stateId) {
        var el = document.getElementById(stateId) || document.querySelector('[data-state-id="' + stateId + '"]');
        if (el) {
          el.classList.add('debug-active-state');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        var label = document.getElementById('debug-state-label');
        if (label) {
          var visitedCount = visited ? visited.length : 0;
          label.innerHTML = 'Paused at <span class="state-name">' + stateId + '</span> <span class="step-count">step ' + (visitedCount + 1) + '</span>';
        }
      }
    }

    // Receive messages from extension host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'triggerBarUpdate') {
        // Only rebuild form when schema actually changes (rare — happens on .rg recompile)
        if (msg.inputSchema !== undefined) {
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
      } else if (msg.type === 'debugSessionStarted') {
        setDebugMode(true);
      } else if (msg.type === 'debugSessionEnded') {
        setDebugMode(false);
      } else if (msg.type === 'debugStopped') {
        highlightDebugState(msg.stateId, msg.visitedStates);
      } else if (msg.type === 'highlightState') {
        highlightDebugState(msg.stateId, null);
      }
    });

    function updateTriggerBarDom(connected, agents, proto) {
      const bar = document.querySelector('.trigger-bar');
      if (!bar) return;
      const statusEl = bar.querySelector('.trigger-status');
      const agentSel = document.getElementById('trigger-agent');

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
        const prev = agentSel.value;
        agentSel.innerHTML = agents.map(function(a) {
          const label = a.name + ' (' + a.role + ' @ ' + a.node + ')';
          return '<option value="' + a.name + '">' + label + '</option>';
        }).join('');
        if (agents.find(function(a) { return a.name === prev; })) agentSel.value = prev;
      }
    }
  </script>
</body>
</html>`;
  }

  private getTriggerBarHtml(
    protoName: string,
    connected: boolean,
    agents: Array<{ name: string; role: string; node: string }>,
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

    const msgLabel = this.compiledData?.inputMessageName
      ? `Input: ${esc(this.compiledData.inputMessageName)}`
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
        <div class="trigger-section-label" id="trigger-msg-label">${msgLabel}</div>
        <div id="trigger-fields" class="trigger-fields"></div>
        <div class="trigger-actions">
          <button id="trigger-btn" class="trigger-button">▶ Trigger</button>
          <button id="debug-trigger-btn" class="trigger-button debug-button">🔍 Debug</button>
        </div>
      </div>
      <div class="debug-controls" id="debug-toolbar" style="display:none">
        <button class="ctrl-btn continue-btn" id="debug-continue" title="Continue (F5)">▶</button>
        <button class="ctrl-btn step-btn" id="debug-step" title="Step State (F10)">⤵</button>
        <button class="ctrl-btn step-btn" id="debug-step-over" title="Step Over">⏩</button>
        <button class="ctrl-btn step-btn" id="debug-step-into" title="Step Into (F11)">↓</button>
        <div class="ctrl-sep"></div>
        <button class="ctrl-btn restart-btn" id="debug-restart" title="Restart">↻</button>
        <button class="ctrl-btn stop-btn" id="debug-stop" title="Stop (Shift+F5)">■</button>
        <div class="ctrl-sep"></div>
        <span class="ctrl-status" id="debug-state-label">Paused at <span class="state-name">...</span></span>
      </div>
    </div>`;
  }

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
    if (f.type?.kind === 'ArrayType') {
      schema.element = typeExprToString(f.type.element);
    }
    if (f.type?.kind === 'ObjectType' && f.type.fields) {
      schema.fields = extractFieldSchemas(f.type.fields);
    }
    return schema;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #d4d4d4); overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-sideBar-background, #252526); gap: 8px; flex-shrink: 0; }
    .toolbar-left, .toolbar-center, .toolbar-right { display: flex; align-items: center; gap: 6px; }
    .proto-name { font-weight: 600; font-size: 13px; }
    .version-tag { font-size: 10px; color: var(--vscode-descriptionForeground, #888); background: var(--vscode-badge-background, #4d4d4d); padding: 1px 6px; border-radius: 8px; }
    .toolbar-select { background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #ccc); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 3px; padding: 3px 6px; font-size: 12px; cursor: pointer; }
    .tab { background: transparent; border: none; color: var(--vscode-foreground, #ccc); padding: 4px 12px; cursor: pointer; font-size: 12px; border-radius: 3px; }
    .tab:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .tab.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
    .diagram-container { flex: 1; padding: 12px; overflow: auto; display: flex; align-items: flex-start; justify-content: center; }
    .diagram-container svg { width: 100%; max-width: 800px; }

    .trigger-bar { border-bottom: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-sideBar-background, #252526); flex-shrink: 0; }
    .trigger-header { padding: 4px 12px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; user-select: none; }
    .trigger-header:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .trigger-status { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-left: auto; }
    .trigger-status.connected { color: var(--vscode-testing-iconPassed, #73c991); }
    .trigger-status.disconnected { color: var(--vscode-testing-iconFailed, #f48771); }
    .trigger-body { display: none; flex-direction: column; gap: 6px; padding: 6px 12px 10px; }
    .trigger-row { display: flex; align-items: center; gap: 8px; }
    .trigger-row label { font-size: 11px; min-width: 40px; color: var(--vscode-descriptionForeground, #888); }
    .trigger-select { flex: 1; background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #ccc); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 3px; padding: 3px 6px; font-size: 12px; }
    .trigger-textarea { flex: 1; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; padding: 4px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; resize: vertical; }
    .trigger-section-label { font-size: 11px; color: var(--vscode-descriptionForeground, #888); padding: 4px 0 2px; border-top: 1px solid var(--vscode-panel-border, #333); margin-top: 4px; }
    .trigger-fields { display: flex; flex-direction: column; gap: 4px; }
    .trigger-field-input { flex: 1; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; padding: 3px 6px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
    .trigger-field-input:focus, .trigger-textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); outline: none; }
    .trigger-actions { display: flex; gap: 6px; margin-top: 4px; }
    .trigger-button { padding: 4px 16px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
    .trigger-button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .trigger-button.debug-button { background: var(--vscode-debugIcon-startForeground, #89d185); color: #000; }
    .trigger-button.debug-button:hover { opacity: 0.85; }

    .debug-controls { display: none; align-items: center; gap: 4px; padding: 4px 12px; background: #1a2e1a; border-bottom: 1px solid var(--vscode-charts-green, #89d185); flex-shrink: 0; }
    .ctrl-btn { background: transparent; border: 1px solid transparent; color: var(--vscode-foreground, #ccc); border-radius: 3px; width: 28px; height: 24px; cursor: pointer; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; padding: 0; line-height: 1; }
    .ctrl-btn:hover { background: rgba(255,255,255,0.08); border-color: var(--vscode-panel-border, #333); }
    .ctrl-btn.continue-btn { color: var(--vscode-debugIcon-startForeground, #89d185); }
    .ctrl-btn.step-btn { color: var(--vscode-charts-blue, #4fc1ff); }
    .ctrl-btn.restart-btn { color: var(--vscode-charts-green, #89d185); }
    .ctrl-btn.stop-btn { color: var(--vscode-testing-iconFailed, #f48771); }
    .ctrl-sep { width: 1px; height: 18px; background: var(--vscode-panel-border, #333); }
    .ctrl-status { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-left: 8px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctrl-status .state-name { color: var(--vscode-debugIcon-startForeground, #89d185); font-weight: 600; }
    .ctrl-status .step-count { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #d4d4d4); padding: 1px 6px; border-radius: 8px; font-size: 10px; margin-left: 6px; }

    .debug-active-state { outline: 2px solid var(--vscode-debugIcon-startForeground, #89d185) !important; outline-offset: 2px; }
    .debug-visited-state { opacity: 1 !important; }
    .debug-visited-state rect, .debug-visited-state ellipse { fill-opacity: 0.3; stroke: var(--vscode-debugIcon-startForeground, #89d185) !important; }
    .debug-breakpoint { position: relative; }
    .debug-breakpoint::after { content: ''; position: absolute; left: -6px; top: 50%; transform: translateY(-50%); width: 10px; height: 10px; background: var(--vscode-debugIcon-breakpointForeground, #e51400); border-radius: 50%; pointer-events: none; }
    [data-state-id].debug-breakpoint > rect, [data-state-id].debug-breakpoint > polygon, [data-state-id].debug-breakpoint > circle { stroke: var(--vscode-debugIcon-breakpointForeground, #e51400) !important; stroke-width: 2.5; }

    .diagram-tooltip { display: none; position: fixed; background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); border-radius: 4px; padding: 6px 10px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground, #d4d4d4); max-width: 350px; white-space: pre; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,0.5); z-index: 1000; pointer-events: none; }
    .diagram-tooltip .tt-state-id { color: var(--vscode-debugIcon-startForeground, #89d185); font-weight: 600; }
    .diagram-tooltip .tt-kind { color: var(--vscode-descriptionForeground, #888); margin-left: 6px; }
    .diagram-tooltip .tt-label { display: block; margin-top: 4px; color: var(--vscode-charts-purple, #b180d7); }
  `;
}
