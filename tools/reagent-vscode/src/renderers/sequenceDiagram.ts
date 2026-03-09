/**
 * sequenceDiagram.ts — HTML+SVG renderer for Reagent sequence diagrams.
 *
 * HTML handles layout (flex column, nested frames, padding/margin).
 * A thin SVG overlay draws lifelines and message arrows, positioned via
 * getBoundingClientRect() in the webview script.
 */

// Types mirrored from lang/src/diagram.ts (avoids ESM/CJS import issues)
export type Participant = {
  name: string;
  lang?: string;
  isInitiator: boolean;
  binding?: "static" | "dynamic";
  cardinality?: "single" | "many";
};
export type SeqElementKind =
  | "message" | "action" | "timer"
  | "loop_start" | "loop_end"
  | "alt_start" | "alt_branch" | "alt_end"
  | "scatter_start" | "scatter_end"
  | "invoke" | "spawn"
  | "par_start" | "par_end";

export type SeqElement = {
  kind: SeqElementKind;
  role: string;
  stateId?: string;
  from?: string;
  to?: string;
  label: string;
  condition?: string;
  collection?: string;
  itemRole?: string;
  protocolName?: string;
  duration?: { value: number; unit: string };
  async?: boolean;
  propagateFlow?: boolean;
  sourceLine?: number;
};

export interface SequenceDiagramData {
  protocolName: string;
  version?: string;
  participants: Participant[];
  elements: SeqElement[];
}

export interface RenderOptions {
  sourceFile?: string;
  /** State ID → source line mapping */
  sourceMap?: Map<string, number>;
  debug?: {
    activeStateId?: string;
    visitedStateIds?: Set<string>;
  };
  /** Live cluster agent bindings: role → agent names bound to that role */
  clusterBindings?: Map<string, string[]>;
}

const COLUMN_WIDTH = 200;

export function renderSequenceDiagram(data: SequenceDiagramData, opts: RenderOptions = {}): string {
  const { participants, elements, version } = data;
  if (participants.length === 0) {
    return '<div class="seq-diagram"><div style="color:#888;padding:40px">No participants</div></div>';
  }

  const partNames = participants.map(p => p.name);
  const totalWidth = 160 + (participants.length - 1) * COLUMN_WIDTH;
  const sourceFile = opts.sourceFile ?? '';

  let html = `<div class="seq-diagram" style="width:${totalWidth}px" data-participants="${esc(JSON.stringify(partNames))}">\n`;

  // Version badge
  if (version) {
    html += `<div class="seq-version-badge">v${esc(version)}</div>\n`;
  }

  // Participant header row
  html += `<div class="seq-header">\n`;
  for (const p of participants) {
    html += `  <div class="seq-participant" data-participant="${esc(p.name)}">`;
    html += `<span class="participant-name">${esc(p.name)}${participantBadges(p)}</span>`;
    if (p.lang) html += ` <span class="participant-lang">[${esc(p.lang)}]</span>`;
    const bound = opts.clusterBindings?.get(p.name);
    if (bound && bound.length > 0) {
      html += `<div class="participant-binding">${bound.map(a => esc(a)).join(', ')}</div>`;
    }
    html += `</div>\n`;
  }
  html += `</div>\n`;

  // Body: SVG overlay will be injected by script; content rows follow
  html += `<div class="seq-body">\n`;
  html += `  <svg class="seq-overlay" xmlns="http://www.w3.org/2000/svg">${arrowDefs()}</svg>\n`;

  // Render elements recursively (frames create nesting)
  html += renderElements(elements, partNames, sourceFile, opts, 0).html;

  html += `</div>\n`; // .seq-body
  html += `</div>\n`; // .seq-diagram
  return html;
}

type RenderResult = { html: string; nextIdx: number };

function renderElements(
  elements: SeqElement[],
  partNames: string[],
  sourceFile: string,
  opts: RenderOptions,
  startIdx: number,
  stopKinds?: Set<SeqElementKind>,
): RenderResult {
  let html = '';
  let i = startIdx;

  while (i < elements.length) {
    const el = elements[i];
    if (stopKinds && stopKinds.has(el.kind)) break;

    const debug = debugClass(el.stateId, opts);
    const srcAttr = sourceAttr(el.stateId, sourceFile, opts.sourceMap, el.kind, el.label, el.sourceLine);

    switch (el.kind) {
      case "message": {
        const asyncBadge = el.async ? ' <span class="async-badge">&#x26A1;</span>' : '';
        html += `<div class="seq-row seq-message step ${debug}" ${srcAttr} data-msg-from="${esc(el.from ?? '')}" data-msg-to="${esc(el.to ?? '')}">`;
        html += `<span class="msg-label">${esc(el.label)}${asyncBadge}</span>`;
        html += `</div>\n`;
        i++;
        break;
      }
      case "action": {
        const ri = partNames.indexOf(el.role);
        const asyncBadge = el.async ? ' <span class="async-badge">&#x26A1;</span>' : '';
        html += `<div class="seq-row seq-action step ${debug}" ${srcAttr} data-col="${ri}">`;
        html += `<span class="action-pill">${esc(el.label || "action")}${asyncBadge}</span>`;
        html += `</div>\n`;
        i++;
        break;
      }
      case "timer": {
        const ri = partNames.indexOf(el.role);
        html += `<div class="seq-row seq-timer step ${debug}" ${srcAttr} data-col="${ri}">`;
        html += `<span class="timer-pill">&#x23F1; ${esc(el.label)}</span>`;
        html += `</div>\n`;
        i++;
        break;
      }
      case "invoke": {
        const ri = partNames.indexOf(el.role);
        html += `<div class="seq-row seq-invoke step ${debug}" ${srcAttr} data-col="${ri}">`;
        html += `<span class="invoke-pill">${esc(el.label)}</span>`;
        html += `</div>\n`;
        i++;
        break;
      }
      case "spawn": {
        const ri = partNames.indexOf(el.role);
        html += `<div class="seq-row seq-spawn step ${debug}" ${srcAttr} data-col="${ri}">`;
        html += `<span class="spawn-pill">${esc(el.label)}</span>`;
        html += `</div>\n`;
        i++;
        break;
      }

      // ── Control frames (scatter, loop, par) ──
      case "scatter_start":
      case "loop_start":
      case "par_start": {
        const frameClass = frameKindClass(el.kind);
        let tagText = el.label;
        if (el.condition) tagText += `  [${el.condition}]`;
        if (el.collection) tagText += `  over ${el.collection}`;
        if (el.itemRole) tagText += ` as ${el.itemRole}`;
        const endKind = el.kind.replace('_start', '_end') as SeqElementKind;

        html += `<div class="seq-frame ${frameClass}">\n`;
        html += `  <div class="frame-tag ${frameClass}">${esc(tagText)}</div>\n`;
        const inner = renderElements(elements, partNames, sourceFile, opts, i + 1, new Set([endKind]));
        html += inner.html;
        html += `</div>\n`;
        i = inner.nextIdx + 1; // skip past the end token
        break;
      }

      // ── Alt frame (special: has branches) ──
      case "alt_start": {
        let tagText = el.label;
        if (el.condition) tagText += `  [${el.condition}]`;

        html += `<div class="seq-frame alt-frame">\n`;
        html += `  <div class="frame-tag alt-frame">${esc(tagText)}</div>\n`;

        const altStops = new Set<SeqElementKind>(["alt_branch" as SeqElementKind, "alt_end" as SeqElementKind]);
        let pos = i + 1;
        while (pos < elements.length) {
          const seg = renderElements(elements, partNames, sourceFile, opts, pos, altStops);
          html += seg.html;
          pos = seg.nextIdx;
          if (pos >= elements.length) break;
          if (elements[pos].kind === "alt_branch") {
            html += `  <div class="alt-divider"></div>\n`;
            if (elements[pos].condition) {
              html += `  <div class="alt-branch-label">[${esc(elements[pos].condition!)}]</div>\n`;
            }
            pos++;
          } else {
            // alt_end
            pos++;
            break;
          }
        }
        i = pos;
        html += `</div>\n`;
        break;
      }

      // end/branch tokens consumed by parent — should not reach here normally
      case "loop_end":
      case "scatter_end":
      case "par_end":
      case "alt_end":
      case "alt_branch":
        i++;
        break;

      default:
        i++;
        break;
    }
  }

  return { html, nextIdx: i };
}

function participantBadges(p: Participant): string {
  let badges = '';
  if (p.isInitiator) badges += ' <span class="p-badge p-badge-init" title="initiator">▶</span>';
  if (p.binding === 'dynamic') badges += ' <span class="p-badge p-badge-dyn" title="dynamic binding">dyn</span>';
  if (p.cardinality === 'many') badges += ' <span class="p-badge p-badge-many" title="many instances">∗</span>';
  return badges;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function frameKindClass(kind: string): string {
  if (kind === "loop_start") return "loop-frame";
  if (kind === "scatter_start") return "scatter-frame";
  if (kind === "par_start") return "par-frame";
  return "";
}

function debugClass(stateId: string | undefined, opts: RenderOptions): string {
  if (!opts.debug || !stateId) return "";
  if (opts.debug.activeStateId === stateId) return "active";
  if (opts.debug.visitedStateIds?.has(stateId)) return "visited";
  return "future";
}

function sourceAttr(stateId: string | undefined, file: string, sourceMap?: Map<string, number>, kind?: string, label?: string, sourceLine?: number): string {
  let attr = stateId ? `data-state-id="${esc(stateId)}"` : "";
  if (kind) attr += ` data-state-kind="${esc(kind)}"`;
  if (label) attr += ` data-state-label="${esc(label)}"`;
  if (stateId && sourceMap) {
    const line = sourceMap.get(stateId);
    if (line != null) {
      attr += ` data-src-line="${line}" data-src-file="${esc(file)}"`;
    }
  } else if (sourceLine != null && file) {
    attr += ` data-src-line="${sourceLine}" data-src-file="${esc(file)}"`;
  }
  return attr;
}

function arrowDefs(): string {
  return `<defs>
  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
    <polygon points="0 0, 10 3.5, 0 7" class="arrowhead-fill"/>
  </marker>
</defs>`;
}

// ── CSS ──────────────────────────────────────────────────────────────

export const SEQUENCE_DIAGRAM_CSS = `
  .seq-diagram {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    position: relative;
    margin: 0 auto;
  }
  .seq-version-badge {
    position: absolute; top: 4px; right: 8px;
    font-size: 9px; color: var(--vscode-descriptionForeground, #888);
  }

  /* ── Header ── */
  .seq-header {
    display: flex;
    justify-content: space-around;
    padding: 10px 0 6px;
  }
  .seq-participant {
    width: ${COLUMN_WIDTH}px;
    text-align: center;
    flex-shrink: 0;
  }
  .seq-participant .participant-name {
    display: inline-block;
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 13px; font-weight: 600;
    color: var(--vscode-foreground, #d4d4d4);
    background: var(--vscode-sideBar-background, #252526);
    border: 1.5px solid var(--vscode-panel-border, #555);
    box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  }
  .seq-participant .participant-lang {
    font-size: 9px; color: var(--vscode-descriptionForeground, #888); font-weight: 400;
  }

  /* ── Participant modifier badges ── */
  .p-badge {
    display: inline-block;
    font-size: 8px; font-weight: 700; line-height: 1;
    padding: 1px 4px; margin-left: 3px;
    border-radius: 3px; vertical-align: middle;
    letter-spacing: 0.2px;
  }
  .p-badge-init { background: rgba(137, 209, 133, 0.18); color: var(--vscode-debugIcon-startForeground, #89d185); border: 1px solid rgba(137, 209, 133, 0.35); }
  .p-badge-dyn  { background: rgba(209, 134, 22, 0.15); color: var(--vscode-charts-orange, #d18616); border: 1px solid rgba(209, 134, 22, 0.3); }
  .p-badge-many { background: rgba(79, 193, 255, 0.15); color: var(--vscode-charts-blue, #4fc1ff); border: 1px solid rgba(79, 193, 255, 0.3); }

  /* ── Live agent binding annotation ── */
  .participant-binding {
    font-size: 9px; font-style: italic;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 2px; line-height: 1.2;
    max-width: ${COLUMN_WIDTH - 20}px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── Body ── */
  .seq-body {
    position: relative;
    padding: 4px 0 16px;
  }
  .seq-overlay {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none; overflow: visible;
  }
  .arrowhead-fill { fill: var(--vscode-charts-blue, #4fc1ff); }

  /* ── Lifelines (SVG) ── */
  .seq-lifeline { stroke: var(--vscode-panel-border, #444); stroke-width: 1; stroke-dasharray: 5 4; }

  /* ── Rows ── */
  .seq-row {
    min-height: 34px;
    display: flex;
    align-items: center;
    position: relative;
  }

  /* ── Messages ── */
  .seq-message {
    justify-content: center;
  }
  .seq-message .msg-label {
    font-size: 10.5px; font-weight: 600;
    color: var(--vscode-charts-blue, #4fc1ff);
    position: relative; z-index: 1;
    pointer-events: auto;
  }
  .msg-arrow-line { stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }

  /* ── Actions ── */
  .seq-action { justify-content: center; }
  .action-pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 11px;
    font-size: 10px; font-weight: 500;
    color: #cda0e7; letter-spacing: 0.2px;
    background: rgba(177, 128, 215, 0.12);
    border: 1px solid var(--vscode-charts-purple, #b180d7);
    white-space: nowrap;
  }

  /* ── Timers ── */
  .seq-timer { justify-content: center; }
  .timer-pill {
    display: inline-block;
    padding: 3px 12px;
    border-radius: 9px;
    font-size: 9.5px;
    color: var(--vscode-charts-yellow, #cca700);
    background: rgba(204, 167, 0, 0.08);
    border: 1px solid var(--vscode-charts-yellow, #cca700);
    white-space: nowrap;
  }

  /* ── Invoke ── */
  .seq-invoke { justify-content: center; }
  .invoke-pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 3px;
    font-size: 10px;
    color: var(--vscode-charts-blue, #4fc1ff);
    background: rgba(79, 193, 255, 0.08);
    border: 1.2px solid var(--vscode-charts-blue, #4fc1ff);
    box-shadow: inset 0 0 0 2px rgba(79, 193, 255, 0.04);
    white-space: nowrap;
  }

  /* ── Spawn ── */
  .seq-spawn { justify-content: center; }
  .spawn-pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 3px;
    font-size: 10px;
    color: var(--vscode-charts-green, #89d185);
    background: rgba(137, 209, 133, 0.08);
    border: 1px dashed var(--vscode-charts-green, #89d185);
    white-space: nowrap;
  }

  .async-badge { font-size: 7px; color: var(--vscode-charts-yellow, #cca700); opacity: 0.7; }

  /* ── Control frames ── */
  .seq-frame {
    border: 1px solid transparent;
    border-radius: 6px;
    margin: 6px 10px;
    padding: 0 0 6px;
    position: relative;
  }
  .scatter-frame { border-color: rgba(209, 134, 22, 0.30); }
  .loop-frame    { border-color: rgba(137, 209, 133, 0.35); }
  .par-frame     { border-color: rgba(177, 128, 215, 0.35); }
  .alt-frame     { border-color: rgba(209, 134, 22, 0.35); }

  .frame-tag {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 6px 0 6px 0;
    font-size: 9px; font-weight: 600; letter-spacing: 0.3px;
  }
  .frame-tag.scatter-frame { background: rgba(209, 134, 22, 0.06); color: var(--vscode-charts-orange, #d18616); }
  .frame-tag.loop-frame    { background: rgba(137, 209, 133, 0.08); color: var(--vscode-charts-green, #89d185); }
  .frame-tag.par-frame     { background: rgba(177, 128, 215, 0.08); color: var(--vscode-charts-purple, #b180d7); }
  .frame-tag.alt-frame     { background: rgba(209, 134, 22, 0.08); color: var(--vscode-charts-orange, #d18616); }

  /* ── Alt branches ── */
  .alt-divider {
    border-top: 0.5px dashed var(--vscode-panel-border, #555);
    margin: 4px 0;
  }
  .alt-branch-label {
    font-size: 9px; font-weight: 600; letter-spacing: 0.3px;
    color: var(--vscode-charts-orange, #d18616);
    padding: 0 10px 4px;
  }

  /* ── Step interactivity ── */
  .step { cursor: pointer; transition: opacity 0.15s ease; }
  .step:hover .action-pill { filter: brightness(1.15); border-width: 1.8px; }

  /* Visited: dim */
  .step.visited .msg-label, .step.visited .action-pill,
  .step.visited .timer-pill, .step.visited .invoke-pill, .step.visited .spawn-pill { opacity: 0.35; }

  /* Active: strong green highlight with glow */
  .step.active {
    background: rgba(137, 209, 133, 0.12);
    border-radius: 6px;
    box-shadow: inset 0 0 0 1.5px rgba(137, 209, 133, 0.35), 0 0 12px rgba(137, 209, 133, 0.15);
    position: relative;
    z-index: 2;
  }
  .step.active .msg-label {
    color: var(--vscode-debugIcon-startForeground, #89d185);
    font-weight: 700;
    text-shadow: 0 0 8px rgba(137, 209, 133, 0.4);
  }
  .step.active .action-pill, .step.active .timer-pill,
  .step.active .invoke-pill, .step.active .spawn-pill {
    border-color: var(--vscode-debugIcon-startForeground, #89d185);
    background: rgba(137, 209, 133, 0.18);
    color: var(--vscode-debugIcon-startForeground, #89d185);
    box-shadow: 0 0 10px rgba(137, 209, 133, 0.35);
    animation: pulse-glow 1.5s ease-in-out infinite;
  }

  /* Future: very dim */
  .step.future .msg-label, .step.future .action-pill,
  .step.future .timer-pill, .step.future .invoke-pill, .step.future .spawn-pill { opacity: 0.2; }

  @keyframes pulse-glow {
    0%, 100% { box-shadow: 0 0 8px rgba(137, 209, 133, 0.3); }
    50% { box-shadow: 0 0 16px rgba(137, 209, 133, 0.5); }
  }
`;

// ── Webview script: draws lifelines + arrows into SVG overlay ────────

export const SEQUENCE_DIAGRAM_SCRIPT = `
(function() {
  var COLUMN_WIDTH = ${COLUMN_WIDTH};

  function drawOverlay() {
    var diagram = document.querySelector('.seq-diagram');
    if (!diagram) return;

    var svg = diagram.querySelector('.seq-overlay');
    if (!svg) return;

    var body = diagram.querySelector('.seq-body');
    if (!body) return;

    var partNames = JSON.parse(diagram.getAttribute('data-participants') || '[]');
    var headers = diagram.querySelectorAll('.seq-participant');
    if (headers.length === 0) return;

    // Get participant X centers relative to .seq-body
    var bodyRect = body.getBoundingClientRect();
    var partCenters = [];
    for (var h = 0; h < headers.length; h++) {
      var nameEl = headers[h].querySelector('.participant-name');
      if (!nameEl) continue;
      var r = nameEl.getBoundingClientRect();
      partCenters.push(r.left + r.width / 2 - bodyRect.left);
    }

    // Set SVG viewBox to match body size
    svg.setAttribute('width', bodyRect.width);
    svg.setAttribute('height', bodyRect.height);
    svg.setAttribute('viewBox', '0 0 ' + bodyRect.width + ' ' + bodyRect.height);

    // Clear previous lines (keep <defs>)
    var defs = svg.querySelector('defs');
    svg.innerHTML = '';
    if (defs) svg.appendChild(defs);

    // Draw lifelines
    for (var li = 0; li < partCenters.length; li++) {
      var x = partCenters[li];
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x);
      line.setAttribute('y1', '0');
      line.setAttribute('x2', x);
      line.setAttribute('y2', bodyRect.height);
      line.setAttribute('class', 'seq-lifeline');
      svg.appendChild(line);
    }

    // Draw message arrows
    var messages = diagram.querySelectorAll('.seq-message');
    for (var m = 0; m < messages.length; m++) {
      var el = messages[m];
      var fromName = el.getAttribute('data-msg-from');
      var toName = el.getAttribute('data-msg-to');
      var fromIdx = partNames.indexOf(fromName);
      var toIdx = partNames.indexOf(toName);
      if (fromIdx < 0 || toIdx < 0) continue;

      var elRect = el.getBoundingClientRect();
      var cy = elRect.top + elRect.height / 2 - bodyRect.top;
      var x1 = partCenters[fromIdx];
      var x2 = partCenters[toIdx];

      var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      arrow.setAttribute('x1', x1);
      arrow.setAttribute('y1', cy);
      arrow.setAttribute('x2', x2);
      arrow.setAttribute('y2', cy);
      arrow.setAttribute('class', 'msg-arrow-line');
      arrow.setAttribute('marker-end', 'url(#arrowhead)');

      // Transfer debug class for active/visited styling (check both render-time and postMessage classes)
      if (el.classList.contains('active') || el.classList.contains('debug-active-state')) arrow.setAttribute('class', 'msg-arrow-line msg-arrow-active');
      else if (el.classList.contains('visited') || el.classList.contains('debug-visited-state')) arrow.setAttribute('class', 'msg-arrow-line msg-arrow-visited');
      else if (el.classList.contains('future')) arrow.setAttribute('class', 'msg-arrow-line msg-arrow-future');

      svg.appendChild(arrow);
    }

    // Position action/timer/invoke/spawn pills at their participant column
    var colRows = diagram.querySelectorAll('[data-col]');
    for (var c = 0; c < colRows.length; c++) {
      var row = colRows[c];
      var col = parseInt(row.getAttribute('data-col'), 10);
      if (isNaN(col) || col < 0 || col >= partCenters.length) continue;
      var centerX = partCenters[col];
      var rowRect = row.getBoundingClientRect();
      var rowCenterX = rowRect.left + rowRect.width / 2 - bodyRect.left;
      var offset = centerX - rowCenterX;
      var pill = row.querySelector('.action-pill, .timer-pill, .invoke-pill, .spawn-pill');
      if (pill) {
        pill.style.position = 'relative';
        pill.style.left = offset + 'px';
      }
    }
  }

  function scrollToActive() {
    var active = document.querySelector('.step.active') || document.querySelector('.debug-active-state');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Draw on load
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      drawOverlay();
      scrollToActive();
    });
  });

  // Redraw on resize
  var ro = new ResizeObserver(function() { requestAnimationFrame(drawOverlay); });
  var diag = document.querySelector('.seq-diagram');
  if (diag) ro.observe(diag);

  // Expose for external re-draw (e.g. after debug state update)
  window.__seqOverlayRedraw = drawOverlay;
})();

  /* SVG arrow styling */
  var style = document.createElement('style');
  style.textContent = [
    '.msg-arrow-line { stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }',
    '.msg-arrow-active { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 2.5; animation: pulse-line 1.5s ease-in-out infinite; }',
    '.msg-arrow-visited { opacity: 0.35; }',
    '.msg-arrow-future { opacity: 0.2; }',
    '@keyframes pulse-line { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.5} }'
  ].join('\\n');
  document.head.appendChild(style);
`;
