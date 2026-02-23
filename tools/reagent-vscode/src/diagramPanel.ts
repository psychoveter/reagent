import * as vscode from 'vscode';

type ViewMode = 'sequence' | 'statemachine';
type DebugState = 'off' | 'on';

interface DiagramMessage {
  type: string;
  stateId?: string;
  line?: number;
  file?: string;
}

export class ReagentDiagramPanel {
  public static readonly viewType = 'reagentDiagram';
  private static instance: ReagentDiagramPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private viewMode: ViewMode = 'sequence';
  private debugState: DebugState = 'off';
  private selectedRole = 'comma';
  private selectedExample = '01-task-execution-basic';
  private disposables: vscode.Disposable[] = [];

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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
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
      this.disposables
    );
    this.render();
  }

  private handleMessage(msg: DiagramMessage): void {
    switch (msg.type) {
      case 'switchView':
        this.viewMode = this.viewMode === 'sequence' ? 'statemachine' : 'sequence';
        this.render();
        break;
      case 'toggleDebug':
        this.debugState = this.debugState === 'off' ? 'on' : 'off';
        this.render();
        break;
      case 'selectRole':
        if (msg.stateId) {
          this.selectedRole = msg.stateId;
          this.render();
        }
        break;
      case 'selectExample':
        if (msg.stateId) {
          this.selectedExample = msg.stateId;
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
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private render(): void {
    this.panel.title = `Reagent: ${this.viewMode === 'sequence' ? 'Sequence' : 'State Machine'}`;
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const isDebug = this.debugState === 'on';
    const isSeq = this.viewMode === 'sequence';

    const protoName = this.selectedExample === '01-task-execution-basic' ? 'TaskExecutionBasic' : 'LoopRetryBackoff';
    const participants = this.selectedExample === '01-task-execution-basic'
      ? 'user [ts], comma [ts], sia [*]'
      : 'comma [ts], sia [*]';
    const initiator = this.selectedExample === '01-task-execution-basic' ? 'user' : 'comma';
    const roles = this.selectedExample === '01-task-execution-basic'
      ? ['user', 'comma', 'sia'] : ['comma', 'sia'];

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${getStyles(isDebug)}
</style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-left">
      <select id="example-select" class="toolbar-select">
        <option value="01-task-execution-basic" ${this.selectedExample === '01-task-execution-basic' ? 'selected' : ''}>01 Task Execution</option>
        <option value="03-loop-retry-backoff" ${this.selectedExample === '03-loop-retry-backoff' ? 'selected' : ''}>03 Loop Retry</option>
      </select>
    </div>
    <div class="toolbar-center">
      <button class="tab ${isSeq ? 'active' : ''}" id="btn-seq">Sequence</button>
      <button class="tab ${!isSeq ? 'active' : ''}" id="btn-sm">State Machine</button>
    </div>
    <div class="toolbar-right">
      ${!isSeq ? `<select id="role-select" class="toolbar-select">
        ${this.getRoleOptions()}
      </select>` : ''}
      <button class="debug-toggle ${isDebug ? 'active' : ''}" id="btn-debug">
        <span class="debug-dot"></span> Debug
      </button>
    </div>
  </div>
  <div class="main">
    <div class="diagram-area">
      ${isDebug ? `<div class="debug-controls visible">
        <button class="ctrl-btn continue-btn" title="Continue">▶</button>
        <button class="ctrl-btn step-btn" title="Step Over">⤵</button>
        <button class="ctrl-btn step-btn" title="Step Into">↓</button>
        <button class="ctrl-btn step-btn" title="Step Out">↑</button>
        <div class="ctrl-sep"></div>
        <button class="ctrl-btn restart-btn" title="Restart">↻</button>
        <button class="ctrl-btn stop-btn" title="Stop">■</button>
        <div class="ctrl-sep"></div>
        <span class="ctrl-status">Paused <span class="step-count">debug</span></span>
      </div>` : ''}
      <div class="diagram-container" id="diagram">
        ${isSeq ? this.getSequenceSvg() : this.getStateMachineSvg()}
      </div>
    </div>
    <div class="side-panel">
      <div class="panel-section">
        <div class="panel-header"><span class="chevron">▼</span> Protocol</div>
        <div class="panel-body">
          <dl class="proto-meta">
            <dt>Protocol</dt><dd>${protoName}</dd>
            <dt>Participants</dt><dd>${participants}</dd>
            <dt>Initiator</dt><dd>${initiator}</dd>
          </dl>
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-header"><span class="chevron">▼</span> Agents</div>
        <div class="panel-body">
          ${roles.map(r => `<div class="agent-card">
            <div class="agent-card-header">
              <span class="agent-dot ${isDebug ? 'running' : 'idle'}"></span>
              <span class="agent-name">${esc(r)}</span>
            </div>
            <div style="color:var(--vscode-disabledForeground);font-size:10px;font-style:italic">Mock state</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-header"><span class="chevron">▼</span> $flow</div>
        <div class="panel-body"><div style="color:var(--vscode-disabledForeground);font-size:10px;font-style:italic">—</div></div>
      </div>
      <div class="panel-section">
        <div class="panel-header"><span class="chevron">▼</span> Messages</div>
        <div class="panel-body"><div style="color:var(--vscode-disabledForeground);font-size:10px;font-style:italic">—</div></div>
      </div>
      <div class="panel-section">
        <div class="panel-header"><span class="chevron">▼</span> Stats</div>
        <div class="panel-body">
          <div class="stats-row">
            <span class="stat-badge agent-stat"><span class="stat-num">${roles.length}</span> agents</span>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-seq')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchView' });
    });
    document.getElementById('btn-sm')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchView' });
    });
    document.getElementById('btn-debug')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggleDebug' });
    });
    document.getElementById('role-select')?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'selectRole', stateId: e.target.value });
    });
    document.getElementById('example-select')?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'selectExample', stateId: e.target.value });
    });

    document.querySelectorAll('[data-src-line]').forEach(el => {
      el.addEventListener('click', () => {
        const line = parseInt(el.getAttribute('data-src-line'), 10);
        const file = el.getAttribute('data-src-file');
        if (line && file) {
          vscode.postMessage({ type: 'clickNode', line, file });
        }
      });
    });

    document.querySelectorAll('.panel-header').forEach(h => {
      h.addEventListener('click', () => h.classList.toggle('collapsed'));
    });

    const tooltip = document.getElementById('tooltip');
    document.querySelectorAll('[data-tooltip]').forEach(el => {
      el.addEventListener('mouseenter', (e) => {
        if (!tooltip) return;
        tooltip.textContent = el.getAttribute('data-tooltip');
        tooltip.style.display = 'block';
        tooltip.style.left = e.pageX + 12 + 'px';
        tooltip.style.top = e.pageY - 8 + 'px';
      });
      el.addEventListener('mouseleave', () => {
        if (tooltip) tooltip.style.display = 'none';
      });
    });
  </script>
  <div id="tooltip" class="tooltip"></div>
</body>
</html>`;
  }

  private getRoleOptions(): string {
    const roles = this.selectedExample === '01-task-execution-basic'
      ? ['user', 'comma', 'sia']
      : ['comma', 'sia'];
    return roles.map(r =>
      `<option value="${r}" ${this.selectedRole === r ? 'selected' : ''}>${r}</option>`
    ).join('');
  }

  /* ── Sequence Diagram (hardcoded SVGs) ──────────────────────── */
  private getSequenceSvg(): string {
    if (this.selectedExample === '03-loop-retry-backoff') {
      return this.getSequence03(this.debugState === 'on');
    }
    return this.getSequence01(this.debugState === 'on');
  }

  private getSequence01(debug: boolean): string {
    const file = 'examples/src/01-task-execution-basic.rg';
    const w = 620; const h = 420;
    const px = [100, 300, 500]; // user, comma, sia
    const names = ['user', 'comma', 'sia'];
    const langs = ['ts', 'ts', '*'];
    const y0 = 70; const dy = 60;
    const visitedUpTo = debug ? 3 : -1; // debug: first 4 steps completed
    const activeStep = debug ? 4 : -1;  // step 4 (comma→sia SubmitIntent) is active

    let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

    // Participant headers
    for (let i = 0; i < 3; i++) {
      svg += `<rect x="${px[i]-40}" y="10" width="80" height="36" rx="4" class="participant-box"/>`;
      svg += `<text x="${px[i]}" y="32" class="participant-label">${names[i]} <tspan class="lang-tag">[${langs[i]}]</tspan></text>`;
      svg += `<line x1="${px[i]}" y1="46" x2="${px[i]}" y2="${h-20}" class="lifeline"/>`;
    }

    const steps = [
      { y: y0,        label: '$flow.taskText = …', from: 0, to: 0, kind: 'action', line: 18 },
      { y: y0+dy,     label: 'TaskRequest',        from: 0, to: 1, kind: 'message', line: 20 },
      { y: y0+dy*2,   label: 'Greeting',           from: 1, to: 0, kind: 'message', line: 22 },
      { y: y0+dy*3,   label: '$flow.dsiBsi = …',   from: 1, to: 1, kind: 'action', line: 28 },
      { y: y0+dy*4,   label: 'SubmitIntent',       from: 1, to: 2, kind: 'message', line: 32 },
    ];

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const cls = this.stepClass(i, visitedUpTo, activeStep, debug);
      if (s.kind === 'message') {
        const x1 = px[s.from]; const x2 = px[s.to];
        svg += `<g class="step ${cls}" data-src-line="${s.line}" data-src-file="${file}"
                   ${debug ? `data-tooltip="${this.mockTooltip(s.label, i <= visitedUpTo)}"` : ''}>`;
        svg += `<line x1="${x1}" y1="${s.y}" x2="${x2}" y2="${s.y}" class="msg-arrow" marker-end="url(#arrowhead)"/>`;
        svg += `<text x="${(x1+x2)/2}" y="${s.y-8}" class="msg-label">${esc(s.label)}</text>`;
        svg += `</g>`;
      } else {
        const cx = px[s.from];
        svg += `<g class="step ${cls}" data-src-line="${s.line}" data-src-file="${file}"
                   ${debug ? `data-tooltip="${this.mockTooltip(s.label, i <= visitedUpTo)}"` : ''}>`;
        svg += `<rect x="${cx-60}" y="${s.y-12}" width="120" height="24" rx="3" class="action-box"/>`;
        svg += `<text x="${cx}" y="${s.y+4}" class="action-label">${esc(s.label)}</text>`;
        svg += `</g>`;
      }
    }

    svg += arrowMarker();
    svg += `</svg>`;
    return svg;
  }

  private getSequence03(debug: boolean): string {
    const file = 'examples/src/03-loop-retry-backoff.rg';
    const w = 500; const h = 520;
    const px = [140, 360]; // comma, sia
    const names = ['comma', 'sia'];
    const langs = ['ts', '*'];
    const y0 = 70; const dy = 50;
    const visitedUpTo = debug ? 4 : -1;
    const activeStep = debug ? 5 : -1;

    let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

    for (let i = 0; i < 2; i++) {
      svg += `<rect x="${px[i]-40}" y="10" width="80" height="36" rx="4" class="participant-box"/>`;
      svg += `<text x="${px[i]}" y="32" class="participant-label">${names[i]} <tspan class="lang-tag">[${langs[i]}]</tspan></text>`;
      svg += `<line x1="${px[i]}" y1="46" x2="${px[i]}" y2="${h-20}" class="lifeline"/>`;
    }

    // Loop box
    svg += `<rect x="50" y="${y0-20}" width="400" height="350" rx="6" class="control-box loop-box"/>`;
    svg += `<text x="60" y="${y0-4}" class="control-label">loop ($ctx.attempt &lt; 3)</text>`;

    // Alt box
    const altY = y0 + dy * 2 - 15;
    svg += `<rect x="70" y="${altY}" width="360" height="225" rx="4" class="control-box alt-box"/>`;
    svg += `<text x="80" y="${altY+16}" class="control-label">alt</text>`;

    const steps = [
      { y: y0+10,      label: '$ctx.attempt = 0',  from: 0, to: 0, kind: 'action', line: 15 },
      { y: y0+dy,      label: 'ValidateIntent',     from: 0, to: 1, kind: 'message', line: 20 },
      { y: altY+40,    label: 'ValidationOk',        from: 1, to: 0, kind: 'message', line: 26, branch: 'ok' },
      { y: altY+70,    label: 'reagent.break()',     from: 0, to: 0, kind: 'action', line: 28 },
      { y: altY+115,   label: 'ValidationError {TRANSIENT}', from: 1, to: 0, kind: 'message', line: 29, branch: 'transient' },
      { y: altY+145,   label: '$ctx.attempt++',      from: 0, to: 0, kind: 'action', line: 30 },
      { y: altY+170,   label: 'wait 1s',             from: 0, to: 0, kind: 'timer', line: 31 },
      { y: altY+200,   label: 'ValidationError {FATAL}', from: 1, to: 0, kind: 'message', line: 32, branch: 'fatal' },
    ];

    // Alt dividers
    svg += `<line x1="70" y1="${altY+95}" x2="430" y2="${altY+95}" class="alt-divider"/>`;
    svg += `<line x1="70" y1="${altY+185}" x2="430" y2="${altY+185}" class="alt-divider"/>`;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const cls = this.stepClass(i, visitedUpTo, activeStep, debug);
      if (s.kind === 'message') {
        const x1 = px[s.from]; const x2 = px[s.to];
        svg += `<g class="step ${cls}" data-src-line="${s.line}" data-src-file="${file}"
                   ${debug ? `data-tooltip="${this.mockTooltip(s.label, i <= visitedUpTo)}"` : ''}>`;
        svg += `<line x1="${x1}" y1="${s.y}" x2="${x2}" y2="${s.y}" class="msg-arrow" marker-end="url(#arrowhead)"/>`;
        svg += `<text x="${(x1+x2)/2}" y="${s.y-8}" class="msg-label">${esc(s.label)}</text>`;
        svg += `</g>`;
      } else if (s.kind === 'timer') {
        const cx = px[s.from];
        svg += `<g class="step ${cls}" data-src-line="${s.line}" data-src-file="${file}"
                   ${debug ? `data-tooltip="Timer: 1s"` : ''}>`;
        svg += `<rect x="${cx-40}" y="${s.y-10}" width="80" height="20" rx="10" class="timer-box"/>`;
        svg += `<text x="${cx}" y="${s.y+4}" class="timer-label">⏱ ${esc(s.label)}</text>`;
        svg += `</g>`;
      } else {
        const cx = px[s.from];
        svg += `<g class="step ${cls}" data-src-line="${s.line}" data-src-file="${file}"
                   ${debug ? `data-tooltip="${this.mockTooltip(s.label, i <= visitedUpTo)}"` : ''}>`;
        svg += `<rect x="${cx-60}" y="${s.y-12}" width="120" height="24" rx="3" class="action-box"/>`;
        svg += `<text x="${cx}" y="${s.y+4}" class="action-label">${esc(s.label)}</text>`;
        svg += `</g>`;
      }
    }

    svg += arrowMarker();
    svg += `</svg>`;
    return svg;
  }

  /* ── State Machine Diagram (hardcoded SVGs) ────────────────── */
  private getStateMachineSvg(): string {
    if (this.selectedExample === '03-loop-retry-backoff') {
      return this.getSM03(this.debugState === 'on');
    }
    return this.getSM01(this.debugState === 'on');
  }

  private getSM01(debug: boolean): string {
    const role = this.selectedRole;
    if (role === 'user') return this.sm01User(debug);
    if (role === 'comma') return this.sm01Comma(debug);
    return this.sm01Sia(debug);
  }

  private sm01User(debug: boolean): string {
    const w = 400; const h = 380;
    const cx = 200; const y0 = 40; const dy = 70;
    const file = 'examples/src/01-task-execution-basic.rg';

    const nodes = [
      { id: 'init_1',  y: y0,       label: '●',                kind: 'initial',  line: 12 },
      { id: 'act_2',   y: y0+dy,    label: '$flow.taskText = …', kind: 'action',  line: 18 },
      { id: 'send_3',  y: y0+dy*2,  label: '→ TaskRequest',     kind: 'send',     line: 20 },
      { id: 'recv_4',  y: y0+dy*3,  label: '← Greeting',        kind: 'receive',  line: 22 },
      { id: 'end_5',   y: y0+dy*4,  label: '◉',                kind: 'terminal', line: 37 },
    ];

    const visitedUpTo = debug ? 2 : -1;
    const activeIdx = debug ? 3 : -1;

    return this.renderSmSvg(w, h, cx, nodes, file, visitedUpTo, activeIdx, debug);
  }

  private sm01Comma(debug: boolean): string {
    const w = 400; const h = 450;
    const cx = 200; const y0 = 40; const dy = 65;
    const file = 'examples/src/01-task-execution-basic.rg';

    const nodes = [
      { id: 'init_6',   y: y0,        label: '●',              kind: 'initial',  line: 12 },
      { id: 'recv_7',   y: y0+dy,     label: '← TaskRequest',   kind: 'receive',  line: 20 },
      { id: 'send_8',   y: y0+dy*2,   label: '→ Greeting',      kind: 'send',     line: 22 },
      { id: 'act_9',    y: y0+dy*3,   label: '$flow.dsiBsi = …', kind: 'action',  line: 28 },
      { id: 'send_10',  y: y0+dy*4,   label: '→ SubmitIntent',  kind: 'send',     line: 32 },
      { id: 'end_11',   y: y0+dy*5,   label: '◉',              kind: 'terminal', line: 37 },
    ];

    const visitedUpTo = debug ? 3 : -1;
    const activeIdx = debug ? 4 : -1;

    return this.renderSmSvg(w, h, cx, nodes, file, visitedUpTo, activeIdx, debug);
  }

  private sm01Sia(debug: boolean): string {
    const w = 400; const h = 250;
    const cx = 200; const y0 = 40; const dy = 70;
    const file = 'examples/src/01-task-execution-basic.rg';

    const nodes = [
      { id: 'init',   y: y0,       label: '●',               kind: 'initial',  line: 12 },
      { id: 'recv',   y: y0+dy,    label: '← SubmitIntent',    kind: 'receive',  line: 32 },
      { id: 'end',    y: y0+dy*2,  label: '◉',               kind: 'terminal', line: 37 },
    ];

    const visitedUpTo = debug ? 0 : -1;
    const activeIdx = debug ? 1 : -1;

    return this.renderSmSvg(w, h, cx, nodes, file, visitedUpTo, activeIdx, debug);
  }

  private getSM03(debug: boolean): string {
    if (this.selectedRole === 'sia') return this.sm03Sia(debug);
    return this.sm03Comma(debug);
  }

  private sm03Comma(debug: boolean): string {
    const w = 500; const h = 650;
    const file = 'examples/src/03-loop-retry-backoff.rg';

    const nodes = [
      { id: 'init_1',       x: 250, y: 30,  label: '●',             kind: 'initial',  line: 10 },
      { id: 'act_2',        x: 250, y: 90,  label: '$ctx.attempt=0', kind: 'action',   line: 15 },
      { id: 'loop_guard_3', x: 250, y: 160, label: 'attempt < 3?',   kind: 'guard',    line: 19 },
      { id: 'send_5',       x: 250, y: 230, label: '→ ValidateIntent',kind: 'send',    line: 20 },
      { id: 'xor_6',        x: 250, y: 300, label: 'alt',            kind: 'guard',    line: 26 },
      { id: 'recv_8',       x: 100, y: 370, label: '← Ok',           kind: 'receive',  line: 26 },
      { id: 'act_9',        x: 100, y: 430, label: 'valid=true',     kind: 'action',   line: 27 },
      { id: 'act_10',       x: 100, y: 490, label: 'break()',        kind: 'action',   line: 28 },
      { id: 'recv_11',      x: 250, y: 370, label: '← Err{T}',       kind: 'receive',  line: 29 },
      { id: 'act_12',       x: 250, y: 430, label: 'attempt++',      kind: 'action',   line: 30 },
      { id: 'timer_13',     x: 250, y: 490, label: '⏱ 1s',          kind: 'timer',    line: 31 },
      { id: 'recv_14',      x: 400, y: 370, label: '← Err{F}',       kind: 'receive',  line: 32 },
      { id: 'act_15',       x: 400, y: 430, label: 'throw',          kind: 'action',   line: 33 },
      { id: 'merge_7',      x: 250, y: 550, label: '◇',             kind: 'guard',    line: 34 },
      { id: 'end_16',       x: 400, y: 160, label: '◉',             kind: 'terminal', line: 36 },
    ];

    const edges = [
      { from: 0,  to: 1 },
      { from: 1,  to: 2 },
      { from: 2,  to: 3,  label: 'true' },
      { from: 3,  to: 4 },
      { from: 4,  to: 5,  label: 'Ok' },
      { from: 4,  to: 8,  label: 'Err{T}' },
      { from: 4,  to: 11, label: 'Err{F}' },
      { from: 5,  to: 6 },
      { from: 6,  to: 7 },
      { from: 7,  to: 13 },
      { from: 8,  to: 9 },
      { from: 9,  to: 10 },
      { from: 10, to: 13 },
      { from: 11, to: 12 },
      { from: 12, to: 13 },
      { from: 13, to: 2,  label: 'loop' },
      { from: 2,  to: 14, label: 'false' },
    ];

    const visitedUpTo = debug ? 5 : -1;
    const activeIdx = debug ? 6 : -1;

    return this.renderSmSvgFreeform(w, h, nodes, edges, file, visitedUpTo, activeIdx, debug);
  }

  private sm03Sia(debug: boolean): string {
    const w = 400; const h = 250;
    const cx = 200;
    const file = 'examples/src/03-loop-retry-backoff.rg';

    const nodes = [
      { id: 'init',  y: 40,  label: '●',                   kind: 'initial',  line: 10 },
      { id: 'recv',  y: 110, label: '← ValidateIntent',     kind: 'receive',  line: 20 },
      { id: 'end',   y: 180, label: '◉',                   kind: 'terminal', line: 36 },
    ];

    return this.renderSmSvg(w, h, cx, nodes, file, debug ? 0 : -1, debug ? 1 : -1, debug);
  }

  /* ── Shared SM renderers ────────────────────────────────────── */

  private renderSmSvg(
    w: number, h: number, cx: number,
    nodes: Array<{ id: string; y: number; label: string; kind: string; line: number }>,
    file: string,
    visitedUpTo: number, activeIdx: number, debug: boolean
  ): string {
    let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

    // Edges (simple vertical chain)
    for (let i = 0; i < nodes.length - 1; i++) {
      const from = nodes[i]; const to = nodes[i + 1];
      svg += `<line x1="${cx}" y1="${from.y + 18}" x2="${cx}" y2="${to.y - 18}" class="sm-edge"/>`;
    }

    // Nodes
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const cls = this.smNodeClass(n.kind, i, visitedUpTo, activeIdx, debug);
      const tooltip = debug ? `data-tooltip="${this.mockSmTooltip(n.id, i <= visitedUpTo)}"` : '';

      if (n.kind === 'initial' || n.kind === 'terminal') {
        svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
        svg += `<circle cx="${cx}" cy="${n.y}" r="14" class="sm-circle sm-${n.kind}"/>`;
        svg += `<text x="${cx}" y="${n.y + 5}" class="sm-label-center">${n.label}</text>`;
        svg += `</g>`;
      } else {
        const shape = n.kind === 'guard' ? 'diamond' : 'rect';
        if (shape === 'diamond') {
          svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
          svg += `<polygon points="${cx},${n.y-20} ${cx+30},${n.y} ${cx},${n.y+20} ${cx-30},${n.y}" class="sm-diamond sm-${n.kind}"/>`;
          svg += `<text x="${cx}" y="${n.y+5}" class="sm-label-center">${esc(n.label)}</text>`;
          svg += `</g>`;
        } else {
          svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
          svg += `<rect x="${cx-65}" y="${n.y-16}" width="130" height="32" rx="4" class="sm-rect sm-${n.kind}"/>`;
          svg += `<text x="${cx}" y="${n.y+5}" class="sm-label-center">${esc(n.label)}</text>`;
          svg += `</g>`;
        }
      }
    }

    svg += arrowMarkerSm();
    svg += `</svg>`;
    return svg;
  }

  private renderSmSvgFreeform(
    w: number, h: number,
    nodes: Array<{ id: string; x: number; y: number; label: string; kind: string; line: number }>,
    edges: Array<{ from: number; to: number; label?: string }>,
    file: string,
    visitedUpTo: number, activeIdx: number, debug: boolean
  ): string {
    let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

    // Edges
    for (const e of edges) {
      const from = nodes[e.from]; const to = nodes[e.to];
      svg += `<line x1="${from.x}" y1="${from.y + 18}" x2="${to.x}" y2="${to.y - 18}" class="sm-edge" marker-end="url(#sm-arrow)"/>`;
      if (e.label) {
        const mx = (from.x + to.x) / 2 + 8;
        const my = (from.y + to.y) / 2;
        svg += `<text x="${mx}" y="${my}" class="sm-edge-label">${esc(e.label)}</text>`;
      }
    }

    // Nodes
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const cls = this.smNodeClass(n.kind, i, visitedUpTo, activeIdx, debug);
      const tooltip = debug ? `data-tooltip="${this.mockSmTooltip(n.id, i <= visitedUpTo)}"` : '';

      if (n.kind === 'initial' || n.kind === 'terminal') {
        svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
        svg += `<circle cx="${n.x}" cy="${n.y}" r="14" class="sm-circle sm-${n.kind}"/>`;
        svg += `<text x="${n.x}" y="${n.y + 5}" class="sm-label-center">${n.label}</text>`;
        svg += `</g>`;
      } else if (n.kind === 'guard') {
        svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
        svg += `<polygon points="${n.x},${n.y-20} ${n.x+30},${n.y} ${n.x},${n.y+20} ${n.x-30},${n.y}" class="sm-diamond sm-guard"/>`;
        svg += `<text x="${n.x}" y="${n.y+5}" class="sm-label-center">${esc(n.label)}</text>`;
        svg += `</g>`;
      } else if (n.kind === 'timer') {
        svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
        svg += `<rect x="${n.x-45}" y="${n.y-14}" width="90" height="28" rx="14" class="sm-rect sm-timer"/>`;
        svg += `<text x="${n.x}" y="${n.y+5}" class="sm-label-center">${esc(n.label)}</text>`;
        svg += `</g>`;
      } else {
        svg += `<g class="sm-node ${cls}" data-src-line="${n.line}" data-src-file="${file}" ${tooltip}>`;
        svg += `<rect x="${n.x-55}" y="${n.y-14}" width="110" height="28" rx="4" class="sm-rect sm-${n.kind}"/>`;
        svg += `<text x="${n.x}" y="${n.y+5}" class="sm-label-center">${esc(n.label)}</text>`;
        svg += `</g>`;
      }
    }

    svg += arrowMarkerSm();
    svg += `</svg>`;
    return svg;
  }

  /* ── CSS class helpers ──────────────────────────────────────── */

  private stepClass(idx: number, visitedUpTo: number, activeIdx: number, debug: boolean): string {
    if (!debug) return '';
    if (idx === activeIdx) return 'active';
    if (idx <= visitedUpTo) return 'visited';
    return 'future';
  }

  private smNodeClass(kind: string, idx: number, visitedUpTo: number, activeIdx: number, debug: boolean): string {
    if (!debug) return '';
    if (idx === activeIdx) return 'active';
    if (idx <= visitedUpTo) return 'visited';
    return 'future';
  }

  private mockTooltip(label: string, visited: boolean): string {
    if (!visited) return esc(`Step: ${label} (pending)`);
    return esc(`Step: ${label}\n$ctx = { attempt: 1, valid: false }\n$flow = { intent: "..." }`);
  }

  private mockSmTooltip(stateId: string, visited: boolean): string {
    if (!visited) return esc(`${stateId} (not yet reached)`);
    return esc(`${stateId}\n$ctx = { attempt: 1 }\n$self = { tasksProcessed: 3 }`);
  }
}

/* ── Shared helpers ───────────────────────────────────────────── */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function arrowMarker(): string {
  return `<defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" class="arrowhead-fill"/>
    </marker>
  </defs>`;
}

function arrowMarkerSm(): string {
  return `<defs>
    <marker id="sm-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" class="arrowhead-fill"/>
    </marker>
  </defs>`;
}

function getStyles(debug: boolean): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #d4d4d4); overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

    .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-sideBar-background, #252526); gap: 8px; flex-shrink: 0; }
    .toolbar-left, .toolbar-center, .toolbar-right { display: flex; align-items: center; gap: 6px; }
    .toolbar-select { background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #ccc); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 3px; padding: 3px 6px; font-size: 12px; cursor: pointer; }
    .tab { background: transparent; border: none; color: var(--vscode-foreground, #ccc); padding: 4px 12px; cursor: pointer; font-size: 12px; border-radius: 3px; }
    .tab:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .tab.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
    .debug-toggle { background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-foreground, #ccc); padding: 3px 10px; cursor: pointer; font-size: 12px; border-radius: 3px; display: flex; align-items: center; gap: 4px; }
    .debug-toggle:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .debug-toggle.active { border-color: var(--vscode-debugIcon-startForeground, #89d185); color: var(--vscode-debugIcon-startForeground, #89d185); }
    .debug-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-foreground, #888); display: inline-block; }
    .debug-toggle.active .debug-dot { background: var(--vscode-debugIcon-startForeground, #89d185); ${debug ? 'animation: pulse 1.5s ease-in-out infinite;' : ''} }

    .main { display: flex; flex: 1; overflow: hidden; }
    .diagram-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
    .debug-controls { display: flex; align-items: center; gap: 6px; padding: 4px 12px; background: #1a2e1a; border-bottom: 1px solid var(--vscode-charts-green, #89d185); flex-shrink: 0; }
    .debug-controls.visible { display: flex; }
    .ctrl-btn { background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-foreground, #ccc); border-radius: 3px; width: 28px; height: 24px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
    .ctrl-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .ctrl-btn.continue-btn { color: var(--vscode-debugIcon-startForeground, #89d185); }
    .ctrl-btn.step-btn { color: var(--vscode-charts-blue, #4fc1ff); }
    .ctrl-btn.stop-btn { color: #f48771; }
    .ctrl-btn.restart-btn { color: var(--vscode-charts-green, #89d185); }
    .ctrl-sep { width: 1px; height: 18px; background: var(--vscode-panel-border, #555); }
    .ctrl-status { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-left: 8px; flex: 1; }
    .ctrl-status .step-count { background: #4d4d4d; color: #d4d4d4; padding: 1px 6px; border-radius: 8px; font-size: 10px; margin-left: 6px; }

    .diagram-container { flex: 1; padding: 12px; overflow: auto; display: flex; align-items: flex-start; justify-content: center; }
    .diagram-container svg { width: 100%; max-width: 650px; }

    .side-panel { width: 280px; flex-shrink: 0; border-left: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-sideBar-background, #252526); overflow-y: auto; overflow-x: hidden; font-size: 11px; }
    .panel-section { border-bottom: 1px solid var(--vscode-panel-border, #333); }
    .panel-header { padding: 6px 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground, #888); background: var(--vscode-editor-background, #1e1e1e); cursor: pointer; display: flex; align-items: center; gap: 4px; user-select: none; }
    .panel-header:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .panel-header .chevron { font-size: 9px; transition: transform 0.15s; }
    .panel-header.collapsed .chevron { transform: rotate(-90deg); }
    .panel-header.collapsed + .panel-body { display: none; }
    .panel-body { padding: 4px 10px 8px; }
    .proto-meta { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
    .proto-meta dt { color: var(--vscode-descriptionForeground, #888); }
    .proto-meta dd { color: var(--vscode-foreground, #d4d4d4); }
    .agent-card { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 6px 8px; margin: 4px 0; }
    .agent-card-header { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
    .agent-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .agent-dot.idle { background: var(--vscode-descriptionForeground, #888); }
    .agent-dot.running { background: var(--vscode-debugIcon-startForeground, #89d185); animation: pulse 1.5s infinite; }
    .agent-name { font-weight: 600; font-size: 11px; }
    .stats-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0; }
    .stat-badge { background: #4d4d4d; color: #d4d4d4; padding: 2px 8px; border-radius: 10px; font-size: 10px; display: flex; align-items: center; gap: 3px; }
    .stat-badge .stat-num { font-weight: 700; }
    .stat-badge.agent-stat { border-left: 2px solid var(--vscode-charts-orange, #d18616); }

    .participant-box { fill: var(--vscode-sideBar-background, #252526); stroke: var(--vscode-panel-border, #555); stroke-width: 1.5; }
    .participant-label { text-anchor: middle; font-size: 13px; font-weight: 600; fill: var(--vscode-foreground, #d4d4d4); }
    .lang-tag { font-size: 10px; fill: var(--vscode-descriptionForeground, #888); font-weight: 400; }
    .lifeline { stroke: var(--vscode-panel-border, #444); stroke-width: 1; stroke-dasharray: 4 3; }
    .msg-arrow { stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }
    .msg-label { text-anchor: middle; font-size: 11px; font-weight: 500; fill: var(--vscode-charts-blue, #4fc1ff); }
    .action-box { fill: var(--vscode-editor-inactiveSelectionBackground, #3a3d41); stroke: var(--vscode-charts-purple, #b180d7); stroke-width: 1; }
    .action-label { text-anchor: middle; font-size: 10px; fill: #cda0e7; }
    .timer-box { fill: var(--vscode-editor-inactiveSelectionBackground, #3a3d41); stroke: var(--vscode-charts-yellow, #cca700); stroke-width: 1; }
    .timer-label { text-anchor: middle; font-size: 10px; fill: var(--vscode-charts-yellow, #cca700); }
    .control-box { fill: none; stroke-width: 1; stroke-dasharray: 5 3; }
    .loop-box { stroke: var(--vscode-charts-green, #89d185); }
    .alt-box { stroke: var(--vscode-charts-orange, #d18616); }
    .control-label { font-size: 10px; font-weight: 600; fill: var(--vscode-descriptionForeground, #999); }
    .alt-divider { stroke: var(--vscode-panel-border, #555); stroke-width: 0.5; stroke-dasharray: 3 2; }
    .arrowhead-fill { fill: var(--vscode-charts-blue, #4fc1ff); }

    .sm-edge { stroke: var(--vscode-panel-border, #555); stroke-width: 1.5; }
    .sm-edge-label { font-size: 9px; fill: var(--vscode-descriptionForeground, #999); }
    .sm-circle { stroke-width: 2; }
    .sm-initial { fill: var(--vscode-foreground, #d4d4d4); stroke: var(--vscode-foreground, #d4d4d4); }
    .sm-terminal { fill: none; stroke: var(--vscode-foreground, #d4d4d4); stroke-width: 3; }
    .sm-rect { stroke-width: 1.5; }
    .sm-send { fill: #1a3a5c; stroke: var(--vscode-charts-blue, #4fc1ff); }
    .sm-receive { fill: #3d2800; stroke: var(--vscode-charts-orange, #d18616); }
    .sm-action { fill: #2d1a4e; stroke: var(--vscode-charts-purple, #b180d7); }
    .sm-timer { fill: #3d3000; stroke: var(--vscode-charts-yellow, #cca700); }
    .sm-diamond { fill: #1a3d1a; stroke: var(--vscode-charts-green, #89d185); stroke-width: 1.5; }
    .sm-label-center { text-anchor: middle; font-size: 11px; fill: var(--vscode-foreground, #d4d4d4); }
    .sm-node { cursor: pointer; }
    .sm-node:hover .sm-rect, .sm-node:hover .sm-diamond, .sm-node:hover .sm-circle { filter: brightness(1.3); }
    .step { cursor: pointer; }
    .step:hover .msg-arrow { stroke-width: 2.5; }
    .step:hover .action-box { filter: brightness(1.3); }

    .step.visited .msg-arrow, .step.visited .msg-label { opacity: 0.4; }
    .step.visited .action-box, .step.visited .action-label { opacity: 0.4; }
    .step.active .msg-arrow { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 2.5; animation: pulse-line 1.5s ease-in-out infinite; }
    .step.active .msg-label { fill: var(--vscode-debugIcon-startForeground, #89d185); }
    .step.active .action-box { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 2; animation: pulse-box 1.5s ease-in-out infinite; }
    .step.future .msg-arrow, .step.future .msg-label, .step.future .action-box, .step.future .action-label { opacity: 0.25; }
    .sm-node.visited .sm-rect, .sm-node.visited .sm-diamond, .sm-node.visited .sm-circle, .sm-node.visited .sm-label-center { opacity: 0.4; }
    .sm-node.active .sm-rect, .sm-node.active .sm-diamond { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 3; animation: pulse-box 1.5s ease-in-out infinite; }
    .sm-node.active .sm-circle { stroke: var(--vscode-debugIcon-startForeground, #89d185); animation: pulse-box 1.5s ease-in-out infinite; }
    .sm-node.future .sm-rect, .sm-node.future .sm-diamond, .sm-node.future .sm-circle, .sm-node.future .sm-label-center { opacity: 0.25; }

    .tooltip { display: none; position: absolute; background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); color: var(--vscode-editorHoverWidget-foreground, #ccc); padding: 6px 10px; border-radius: 4px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); white-space: pre; z-index: 100; pointer-events: none; max-width: 350px; box-shadow: 0 2px 8px rgba(0,0,0,0.5); }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes pulse-line { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.5} }
    @keyframes pulse-box { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.4} }
  `;
}
