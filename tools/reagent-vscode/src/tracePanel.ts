import * as vscode from 'vscode';
import type { ClusterPanelProvider } from './clusterPanel';

export class ReagentTracePanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'reagentTracePanel';

  private view: vscode.WebviewView | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRenderedCount = 0;

  constructor(private readonly cluster: ClusterPanelProvider) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.render();

    this.refreshTimer = setInterval(() => {
      const entries = this.cluster.getTraceEntries();
      if (entries.length !== this.lastRenderedCount) {
        this.render();
      }
    }, 500);

    webviewView.onDidDispose(() => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    });
  }

  private render(): void {
    if (!this.view) return;

    const entries = this.cluster.getTraceEntries();
    this.lastRenderedCount = entries.length;

    const rows = entries
      .slice(-100)
      .reverse()
      .map((e, i) => {
        const time = new Date(e.ts).toLocaleTimeString();
        const icon = kindIcon(e.kind);
        const { summary, extra } = formatDetail(e);
        const agentLabel = e.role ? `${e.agent} (${e.role})` : e.agent;
        const extraRow = extra
          ? `<tr class="detail-row" id="detail-${i}" style="display:none">
              <td colspan="5"><pre class="detail-json">${esc(extra)}</pre></td>
            </tr>`
          : '';
        return `<tr class="row-${kindClass(e.kind)}${extra ? ' clickable' : ''}"
            ${extra ? `onclick="toggleDetail(${i})"` : ''}>
          <td class="ts">${esc(time)}</td>
          <td class="icon">${icon}</td>
          <td class="kind">${esc(shortKind(e.kind))}</td>
          <td class="agent">${esc(agentLabel)}</td>
          <td class="detail">${esc(summary)}${extra ? ' <span class="expand-hint">▸</span>' : ''}</td>
        </tr>${extraRow}`;
      })
      .join('');

    this.view.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 4px;
    margin: 0;
  }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 4px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ts { color: var(--vscode-descriptionForeground); width: 65px; font-size: 11px; }
  .icon { width: 16px; text-align: center; }
  .kind { width: 80px; font-weight: 600; }
  .agent { width: 80px; color: var(--vscode-symbolIcon-functionForeground); }
  .detail { color: var(--vscode-descriptionForeground); max-width: 350px; }
  .detail-row pre.detail-json { margin: 2px 0 6px; padding: 4px 8px; font-size: 11px; white-space: pre-wrap; word-break: break-all;
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); border-radius: 3px;
    color: var(--vscode-foreground); max-height: 200px; overflow: auto; }
  .clickable { cursor: pointer; }
  .clickable:hover td { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.1)); }
  .expand-hint { font-size: 10px; opacity: 0.5; }
  .row-protocol .kind { color: var(--vscode-debugIcon-startForeground, #89d185); }
  .row-message .kind { color: var(--vscode-charts-blue, #3794ff); }
  .row-action .kind { color: var(--vscode-charts-yellow, #cca700); }
  .row-error .kind { color: var(--vscode-errorForeground, #f48771); }
  .row-scatter .kind { color: var(--vscode-charts-purple, #b180d7); }
  .row-guard .kind { color: var(--vscode-charts-orange, #d18616); }
  .empty { color: var(--vscode-disabledForeground); font-style: italic; padding: 16px 4px; }
  h3 { margin: 4px 0 8px; font-size: 1em; display: flex; align-items: center; gap: 6px; }
  .count { font-size: 11px; color: var(--vscode-descriptionForeground); font-weight: normal; }
</style>
</head>
<body>
  <h3>Trace <span class="count">${entries.length} event${entries.length !== 1 ? 's' : ''}</span></h3>
  ${entries.length === 0
    ? '<div class="empty">No trace events yet. Deploy and trigger a protocol.</div>'
    : `<table>${rows}</table>`
  }
<script>
function toggleDetail(i) {
  const row = document.getElementById('detail-' + i);
  if (!row) return;
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'table-row';
  const prev = row.previousElementSibling;
  if (prev) {
    const hint = prev.querySelector('.expand-hint');
    if (hint) hint.textContent = visible ? '▸' : '▾';
  }
}
</script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortKind(kind: string): string {
  const map: Record<string, string> = {
    ProtocolStarted: 'Started',
    ProtocolCompleted: 'Done',
    ProtocolFailed: 'Failed',
    MessageSent: 'Sent',
    MessageReceived: 'Recv',
    ActionStarted: 'Action▶',
    ActionFinished: 'Action✓',
    GuardEvaluated: 'Guard',
    ScatterStarted: 'Scatter▶',
    ScatterCompleted: 'Scatter✓',
    InvokeStarted: 'Invoke▶',
    InvokeCompleted: 'Invoke✓',
    Spawned: 'Spawn',
    ErrorCaught: 'Caught',
    EventEmitted: 'Event',
  };
  return map[kind] ?? kind;
}

function kindIcon(kind: string): string {
  if (kind.startsWith('Protocol')) return kind.includes('Failed') ? '❌' : '🟢';
  if (kind === 'MessageSent') return '📤';
  if (kind === 'MessageReceived') return '📥';
  if (kind.startsWith('Action')) return '⚡';
  if (kind.startsWith('Scatter')) return '🔀';
  if (kind === 'GuardEvaluated') return '🔀';
  if (kind.includes('Invoke')) return '🔗';
  if (kind === 'ErrorCaught') return '⚠️';
  return '•';
}

function kindClass(kind: string): string {
  if (kind.startsWith('Protocol')) return kind.includes('Failed') ? 'error' : 'protocol';
  if (kind.includes('Message')) return 'message';
  if (kind.includes('Action')) return 'action';
  if (kind.includes('Scatter')) return 'scatter';
  if (kind.includes('Guard')) return 'guard';
  if (kind.includes('Error') || kind.includes('Failed')) return 'error';
  return 'action';
}

function formatDetail(e: { kind: string; messageName?: string; role?: string; protocolName?: string; detail: string }): { summary: string; extra: string } {
  try {
    const parsed = JSON.parse(e.detail);
    const data = parsed.data ?? {};

    let summary = '';

    if (data.messageName) {
      summary = data.messageName;
      if (data.to) summary += ` → ${data.to}`;
      if (data.from) summary += ` ← ${data.from}`;
      if (data.toRole) summary += ` (${data.toRole})`;
      if (data.fromRole) summary += ` (${data.fromRole})`;
    } else if (data.protocolName) {
      summary = data.protocolName;
    } else if (data.error) {
      summary = `error: ${data.error}`;
    } else if (data.expr) {
      summary = data.expr;
      if (data.result !== undefined) summary += ` = ${data.result}`;
    } else if (data.zone) {
      summary = `zone: ${data.zone}`;
    } else if (data.stateId) {
      summary = data.stateId;
    } else {
      summary = e.role ?? '';
    }

    const hasData = Object.keys(data).length > 0;
    const extra = hasData ? JSON.stringify(data, null, 2) : '';

    return { summary, extra };
  } catch {
    return { summary: e.role ?? '', extra: '' };
  }
}
