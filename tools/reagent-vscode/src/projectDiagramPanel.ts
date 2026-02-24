/**
 * projectDiagramPanel.ts — Webview panel for the Reagent project architecture diagram.
 *
 * Scans all .rg files in the workspace to build a project-level view showing
 * protocols, roles, agents, and their relationships. Nodes are clickable
 * to navigate to source.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  buildProjectDiagram,
  renderProjectDiagram,
  PROJECT_DIAGRAM_CSS,
  type ProjectDiagramData,
} from './projectDiagram';

interface PanelMessage {
  type: string;
  file?: string;
  line?: number;
}

export class ProjectDiagramPanel implements vscode.Disposable {
  public static readonly viewType = 'reagentProjectDiagram';
  private static instance: ProjectDiagramPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private data: ProjectDiagramData | null = null;

  public static createOrShow(): ProjectDiagramPanel {
    if (ProjectDiagramPanel.instance) {
      ProjectDiagramPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      ProjectDiagramPanel.instance.refresh();
      return ProjectDiagramPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      ProjectDiagramPanel.viewType,
      'Reagent: Project Overview',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ProjectDiagramPanel.instance = new ProjectDiagramPanel(panel);
    return ProjectDiagramPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: PanelMessage) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // Refresh when any .rg file is saved
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.fileName.endsWith('.rg') || doc.fileName.endsWith('agent.json') || doc.fileName.endsWith('reagent.json')) {
          this.refresh();
        }
      }),
    );

    this.refresh();
  }

  async refresh(): Promise<void> {
    const { files, projectName } = await this.collectRgFiles();
    this.data = buildProjectDiagram(projectName, files);
    this.render();
  }

  private render(): void {
    const data = this.data;
    if (!data) {
      this.panel.webview.html = this.errorHtml('No Reagent project found. Open a workspace containing .rg files.');
      return;
    }
    if (data.nodes.length === 0) {
      this.panel.webview.html = this.errorHtml('No protocols, roles, or agents found in .rg files.');
      return;
    }

    const svgContent = renderProjectDiagram(data);

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #d4d4d4);
    overflow: auto;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    background: var(--vscode-sideBar-background, #252526);
    flex-shrink: 0;
  }
  .toolbar-title { font-weight: 600; font-size: 13px; }
  .toolbar-stats { font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
  .toolbar-btn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  .toolbar-btn:hover { filter: brightness(1.2); }
  .diagram-container {
    flex: 1;
    padding: 16px;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }
  .diagram-container svg { width: 100%; max-width: 900px; }
  .legend {
    display: flex;
    gap: 16px;
    padding: 6px 12px;
    border-top: 1px solid var(--vscode-panel-border, #333);
    background: var(--vscode-sideBar-background, #252526);
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    flex-shrink: 0;
  }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; }
  .legend-dot.agent { background: #d18616; }
  .legend-dot.role { background: #89d185; }
  .legend-dot.protocol { background: #4fc1ff; }
  ${PROJECT_DIAGRAM_CSS}
</style>
</head>
<body>
  <div class="toolbar">
    <div>
      <span class="toolbar-title">${esc(data.projectName)}</span>
      <span class="toolbar-stats">&nbsp;— ${data.nodes.filter(n => n.kind === 'protocol').length} protocols, ${data.nodes.filter(n => n.kind === 'role').length} roles, ${data.nodes.filter(n => n.kind === 'agent').length} agents</span>
    </div>
    <button class="toolbar-btn" id="btn-refresh">↻ Refresh</button>
  </div>
  <div class="diagram-container">
    ${svgContent}
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot agent"></div>Agent</div>
    <div class="legend-item"><div class="legend-dot role"></div>Role</div>
    <div class="legend-item"><div class="legend-dot protocol"></div>Protocol</div>
    <div class="legend-item">→ runs / plays as</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    document.querySelectorAll('[data-src-file]').forEach(el => {
      el.addEventListener('click', () => {
        const file = el.getAttribute('data-src-file');
        const line = parseInt(el.getAttribute('data-src-line') || '1', 10);
        if (file) vscode.postMessage({ type: 'navigate', file, line });
      });
    });
  </script>
</body>
</html>`;
  }

  private handleMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case 'refresh':
        this.refresh();
        break;
      case 'navigate':
        if (msg.file) {
          const uri = vscode.Uri.file(msg.file);
          const line = (msg.line ?? 1) - 1;
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(line, 0, line, 0),
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.One,
          });
        }
        break;
    }
  }

  /**
   * Find the nearest reagent.json by walking up from the active .rg file.
   * Returns { projectRoot, manifest } or null.
   */
  private findProject(): { root: string; manifest: any } | null {
    const activeFile = vscode.window.activeTextEditor?.document.fileName;
    const startDir = activeFile ? path.dirname(activeFile) : undefined;

    // Walk up from active file or try workspace root
    const searchRoots: string[] = [];
    if (startDir) {
      let dir = startDir;
      for (let i = 0; i < 10; i++) {
        searchRoots.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      searchRoots.push(folder.uri.fsPath);
    }

    for (const dir of searchRoots) {
      const candidate = path.join(dir, 'reagent.json');
      if (fs.existsSync(candidate)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          return { root: dir, manifest };
        } catch { /* skip malformed */ }
      }
    }
    return null;
  }

  /**
   * Collect .rg files scoped to the Reagent project (using globs from reagent.json).
   */
  private async collectRgFiles(): Promise<{ files: Map<string, string>; projectName: string }> {
    const project = this.findProject();
    if (!project) {
      return { files: new Map(), projectName: 'No Reagent Project' };
    }

    const { root, manifest } = project;
    const projectName: string = manifest.name ?? path.basename(root);

    // Gather globs from manifest (protocols + agents patterns)
    const globs: string[] = [
      ...(manifest.protocols ?? ['protocols/**/*.rg']),
      ...(manifest.agents ?? ['agents/**/*.rg']),
    ];

    const files = new Map<string, string>();
    for (const glob of globs) {
      const pattern = new vscode.RelativePattern(root, glob);
      const uris = await vscode.workspace.findFiles(pattern);
      for (const uri of uris) {
        if (files.has(uri.fsPath)) continue;
        try {
          const content = fs.readFileSync(uri.fsPath, 'utf8');
          files.set(uri.fsPath, content);
        } catch { /* skip */ }
      }
    }

    return { files, projectName };
  }

  private errorHtml(message: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body { font-family: var(--vscode-font-family, monospace); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-descriptionForeground, #888); padding: 40px; }</style>
</head><body>${esc(message)}</body></html>`;
  }

  dispose(): void {
    ProjectDiagramPanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
