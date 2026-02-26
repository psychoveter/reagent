import * as vscode from 'vscode';
import type { ReagentDiagramPanel } from './diagramPanel';

interface TraceEntry {
  kind: string;
  agentName?: string;
  instanceId?: string;
  timestamp?: number;
  detail?: Record<string, unknown>;
}

/**
 * WebviewView provider for the Reagent Debug panel.
 * Shows debug controls, trace timeline, agent state cards, and held messages.
 */
export class ReagentDebugPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'reagentDebugPanel';
  private view: vscode.WebviewView | undefined;
  private traces: TraceEntry[] = [];
  private agentStates = new Map<string, Record<string, unknown>>();
  private heldMessages: Array<{ messageName: string; from: string; to: string }> = [];
  private debugState: { active: boolean; stateId: string | null; stepCount: number } = { active: false, stateId: null, stepCount: 0 };
  private diagramAccessor: (() => ReagentDiagramPanel | null) | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setDiagramPanelAccessor(accessor: () => ReagentDiagramPanel | null): void {
    this.diagramAccessor = accessor;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'debugAction' && msg.command) {
        vscode.commands.executeCommand(`reagent.debug.${msg.command}`);
      }
    });
    this.render();
  }

  addTrace(entry: TraceEntry): void {
    this.traces.push(entry);
    if (this.traces.length > 500) {
      this.traces = this.traces.slice(-250);
    }
    this.render();
  }

  updateAgentState(agentName: string, state: Record<string, unknown>): void {
    this.agentStates.set(agentName, state);
    this.render();
  }

  updateHeldMessages(msgs: Array<{ messageName: string; from: string; to: string }>): void {
    this.heldMessages = msgs;
    this.render();
  }

  updateDebugState(active: boolean, stateId?: string | null, stepCount?: number): void {
    this.debugState = { active, stateId: stateId ?? null, stepCount: stepCount ?? 0 };
    this.render();
  }

  clear(): void {
    this.traces = [];
    this.agentStates.clear();
    this.heldMessages = [];
    this.debugState = { active: false, stateId: null, stepCount: 0 };
    this.render();
  }

  private render(): void {
    if (!this.view) return;

    const dp = this.diagramAccessor?.();
    const ds = dp?.getDebugState() ?? this.debugState;

    const tracesHtml = this.traces
      .slice(-50)
      .reverse()
      .map(t => {
        const agent = t.agentName ? `<span class="agent">${esc(t.agentName)}</span>` : '';
        const kind = `<span class="kind kind-${esc(t.kind)}">${esc(t.kind)}</span>`;
        return `<div class="trace-entry">${kind} ${agent}</div>`;
      })
      .join('');

    const statesHtml = Array.from(this.agentStates.entries())
      .map(([name, state]) => {
        const stateStr = JSON.stringify(state, null, 2);
        return `<div class="agent-card">
          <div class="agent-name">${esc(name)}</div>
          <pre>${esc(stateStr)}</pre>
        </div>`;
      })
      .join('');

    const heldHtml = this.heldMessages
      .map(m => `<div class="held-msg">${esc(m.messageName)} <span class="held-route">${esc(m.from)} → ${esc(m.to)}</span></div>`)
      .join('') || '<div class="empty">No held messages</div>';

    const stateLabel = ds.stateId ? esc(ds.stateId) : '...';
    const controlsVisibility = ds.active ? 'flex' : 'none';

    this.view.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --border: var(--vscode-panel-border);
    --bg-secondary: var(--vscode-sideBar-background);
    --fg-dim: var(--vscode-descriptionForeground);
    --fg-disabled: var(--vscode-disabledForeground);
    --accent-green: var(--vscode-debugIcon-startForeground, #89d185);
    --accent-blue: var(--vscode-charts-blue, #4fc1ff);
    --accent-red: var(--vscode-testing-iconFailed, #f48771);
    --accent-warn: var(--vscode-editorWarning-foreground, #cca700);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #d4d4d4);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --card-bg: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--fg); padding: 0; }

  /* ── Debug Controls ── */
  .debug-controls {
    display: ${controlsVisibility};
    align-items: center;
    gap: 2px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--accent-green) 8%, var(--bg-secondary));
    border-bottom: 1px solid color-mix(in srgb, var(--accent-green) 30%, var(--border));
  }
  .ctrl-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg);
    border-radius: 4px;
    width: 26px; height: 24px;
    cursor: pointer;
    font-size: 13px;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0; line-height: 1;
    transition: background 0.1s;
  }
  .ctrl-btn:hover { background: rgba(255,255,255,0.08); border-color: var(--border); }
  .ctrl-btn.continue { color: var(--accent-green); }
  .ctrl-btn.step { color: var(--accent-blue); }
  .ctrl-btn.restart { color: var(--accent-green); }
  .ctrl-btn.stop { color: var(--accent-red); }
  .ctrl-sep { width: 1px; height: 16px; background: var(--border); margin: 0 3px; }
  .ctrl-state {
    font-size: 11px; color: var(--fg-dim);
    margin-left: 4px; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ctrl-state .state-id { color: var(--accent-green); font-weight: 600; }
  .ctrl-state .badge {
    background: var(--badge-bg); color: var(--badge-fg);
    padding: 1px 5px; border-radius: 8px; font-size: 10px; margin-left: 4px;
  }

  /* ── Sections ── */
  .section { padding: 0; }
  .section-header {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--fg-dim);
    padding: 8px 10px 4px;
    border-top: 1px solid var(--border);
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 5px;
  }
  .section-header:first-child { border-top: none; }
  .section-header .chevron { font-size: 10px; transition: transform 0.15s; }
  .section-header.collapsed .chevron { transform: rotate(-90deg); }
  .section-header .count {
    margin-left: auto;
    background: var(--badge-bg); color: var(--badge-fg);
    padding: 0 5px; border-radius: 8px; font-size: 10px; font-weight: 400;
  }
  .section-body { padding: 2px 10px 8px; }
  .section-body.collapsed { display: none; }

  /* ── Trace entries ── */
  .trace-entry { padding: 2px 0; font-size: 11px; display: flex; align-items: baseline; gap: 4px; }
  .kind {
    font-weight: 600; font-size: 10px;
    padding: 1px 5px; border-radius: 3px;
    background: var(--card-bg);
  }
  .kind-ProtocolStarted, .kind-ProtocolCompleted { color: var(--accent-green); }
  .kind-MessageSent, .kind-MessageReceived { color: var(--accent-blue); }
  .kind-ActionStarted, .kind-ActionFinished { color: #b180d7; }
  .kind-ProtocolFailed { color: var(--accent-red); }
  .agent { color: var(--accent-blue); }

  /* ── Agent cards ── */
  .agent-card {
    background: var(--card-bg);
    padding: 6px 8px; margin: 3px 0;
    border-radius: 4px; border-left: 2px solid var(--accent-blue);
  }
  .agent-name { font-weight: 600; font-size: 11px; margin-bottom: 3px; }
  .agent-card pre {
    margin: 0; font-size: 11px; line-height: 1.4;
    white-space: pre-wrap; word-break: break-all;
    color: var(--fg-dim); font-family: var(--vscode-editor-font-family, monospace);
  }

  /* ── Held messages ── */
  .held-msg {
    padding: 3px 0; font-size: 11px;
    color: var(--accent-warn); font-weight: 500;
  }
  .held-route { color: var(--fg-dim); font-weight: 400; }
  .empty { color: var(--fg-disabled); font-style: italic; font-size: 11px; padding: 2px 0; }
</style>
</head>
<body>
  <div class="debug-controls" id="debug-controls">
    <button class="ctrl-btn continue" onclick="act('continue')" title="Continue (F5)">&#x25B6;</button>
    <button class="ctrl-btn step" onclick="act('stepState')" title="Step State (F10)">&#x2935;</button>
    <button class="ctrl-btn step" onclick="act('stepOver')" title="Step Over">&#x23E9;</button>
    <button class="ctrl-btn step" onclick="act('stepInto')" title="Step Into (F11)">&#x2193;</button>
    <div class="ctrl-sep"></div>
    <button class="ctrl-btn restart" onclick="act('restart')" title="Restart">&#x21BB;</button>
    <button class="ctrl-btn stop" onclick="act('stop')" title="Stop (Shift+F5)">&#x25A0;</button>
    <div class="ctrl-sep"></div>
    <span class="ctrl-state"><span class="state-id">${stateLabel}</span>${ds.stepCount > 0 ? `<span class="badge">${ds.stepCount}</span>` : ''}</span>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggle('traces')">
      <span class="chevron" id="traces-chevron">&#x25BE;</span>
      Trace Timeline
      <span class="count">${this.traces.length}</span>
    </div>
    <div class="section-body" id="traces">
      ${tracesHtml || '<div class="empty">No traces yet</div>'}
    </div>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggle('states')">
      <span class="chevron" id="states-chevron">&#x25BE;</span>
      Agent States
      <span class="count">${this.agentStates.size}</span>
    </div>
    <div class="section-body" id="states">
      ${statesHtml || '<div class="empty">No agent state</div>'}
    </div>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggle('held')">
      <span class="chevron" id="held-chevron">&#x25BE;</span>
      Held Messages
      <span class="count">${this.heldMessages.length}</span>
    </div>
    <div class="section-body" id="held">
      ${heldHtml}
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function act(cmd) { vscode.postMessage({ type: 'debugAction', command: cmd }); }
    function toggle(id) {
      var body = document.getElementById(id);
      var chev = document.getElementById(id + '-chevron');
      if (!body) return;
      var header = chev?.parentElement;
      if (body.classList.contains('collapsed')) {
        body.classList.remove('collapsed');
        if (header) header.classList.remove('collapsed');
      } else {
        body.classList.add('collapsed');
        if (header) header.classList.add('collapsed');
      }
    }
  </script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
