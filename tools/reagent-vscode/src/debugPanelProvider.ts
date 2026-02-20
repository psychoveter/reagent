import * as vscode from 'vscode';

interface TraceEntry {
  kind: string;
  agentName?: string;
  instanceId?: string;
  timestamp?: number;
  detail?: Record<string, unknown>;
}

/**
 * WebviewView provider for the Reagent Debug panel.
 * Shows trace timeline, agent state cards, and held messages.
 */
export class ReagentDebugPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'reagentDebugPanel';
  private view: vscode.WebviewView | undefined;
  private traces: TraceEntry[] = [];
  private agentStates = new Map<string, Record<string, unknown>>();
  private heldMessages: Array<{ messageName: string; from: string; to: string }> = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
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

  clear(): void {
    this.traces = [];
    this.agentStates.clear();
    this.heldMessages = [];
    this.render();
  }

  private render(): void {
    if (!this.view) return;

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
          <h3>${esc(name)}</h3>
          <pre>${esc(stateStr)}</pre>
        </div>`;
      })
      .join('');

    const heldHtml = this.heldMessages
      .map(m => `<div class="held-msg">${esc(m.messageName)} (${esc(m.from)} → ${esc(m.to)})</div>`)
      .join('') || '<div class="empty">No held messages</div>';

    this.view.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; }
  h2 { font-size: 1.1em; margin: 12px 0 4px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .trace-entry { padding: 2px 0; font-size: 0.9em; }
  .kind { font-weight: bold; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; }
  .kind-ProtocolStarted, .kind-ProtocolCompleted { color: var(--vscode-debugIcon-startForeground); }
  .kind-MessageSent, .kind-MessageReceived { color: var(--vscode-debugIcon-stepOverForeground); }
  .kind-ActionStarted, .kind-ActionFinished { color: var(--vscode-debugIcon-stepIntoForeground); }
  .agent { color: var(--vscode-symbolIcon-functionForeground); margin-left: 4px; }
  .agent-card { background: var(--vscode-editor-inactiveSelectionBackground); padding: 8px; margin: 4px 0; border-radius: 4px; }
  .agent-card h3 { margin: 0 0 4px; font-size: 1em; }
  .agent-card pre { margin: 0; font-size: 0.85em; white-space: pre-wrap; }
  .held-msg { padding: 2px 0; color: var(--vscode-editorWarning-foreground); }
  .empty { color: var(--vscode-disabledForeground); font-style: italic; }
</style>
</head>
<body>
  <h2>Trace Timeline</h2>
  <div id="traces">${tracesHtml || '<div class="empty">No traces yet</div>'}</div>
  <h2>Agent States</h2>
  <div id="states">${statesHtml || '<div class="empty">No agent state</div>'}</div>
  <h2>Held Messages</h2>
  <div id="held">${heldHtml}</div>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
