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

type ViewMode = 'sequence' | 'statemachine';

interface DiagramMessage {
  type: string;
  stateId?: string;
  line?: number;
  file?: string;
  role?: string;
}

interface CompiledData {
  protocolName: string;
  version?: string;
  sequenceDiagram: SequenceDiagramData;
  stateMachines: Map<string, StateMachineDiagramData>;
  sourceFile: string;
  sourceMap: Map<string, number>;
  roles: string[];
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

  public static getInstance(): ReagentDiagramPanel | undefined {
    return ReagentDiagramPanel.instance;
  }

  public static createOrShow(extensionUri: vscode.Uri): ReagentDiagramPanel {
    const column = vscode.ViewColumn.Beside;
    if (ReagentDiagramPanel.instance) {
      ReagentDiagramPanel.instance.panel.reveal(column);
      return ReagentDiagramPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      ReagentDiagramPanel.viewType,
      'Reagent Protocol',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ReagentDiagramPanel.instance = new ReagentDiagramPanel(panel, extensionUri);
    return ReagentDiagramPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel, private extensionUri: vscode.Uri) {
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

      this.compiledData = {
        protocolName: proto.name,
        version: seqDiagram.version,
        sequenceDiagram: seqDiagram,
        stateMachines,
        sourceFile: document.uri.fsPath,
        sourceMap,
        roles,
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
    }
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
    this.panel.title = `Reagent: ${isSeq ? 'Sequence' : 'State Machine'}`;
    this.panel.webview.html = this.getHtml(debug);
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
  <div class="diagram-container">
    ${diagramSvg}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-seq')?.addEventListener('click', () => vscode.postMessage({ type: 'switchView' }));
    document.getElementById('btn-sm')?.addEventListener('click', () => vscode.postMessage({ type: 'switchView' }));
    document.getElementById('role-select')?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'selectRole', role: e.target.value });
    });
    document.querySelectorAll('[data-src-line]').forEach(el => {
      el.addEventListener('click', () => {
        const line = parseInt(el.getAttribute('data-src-line'), 10);
        const file = el.getAttribute('data-src-file');
        if (line && file) vscode.postMessage({ type: 'clickNode', line, file });
      });
    });
  </script>
</body>
</html>`;
  }

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
  `;
}
