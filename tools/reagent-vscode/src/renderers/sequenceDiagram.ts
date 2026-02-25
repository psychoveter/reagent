/**
 * sequenceDiagram.ts — SVG renderer for Reagent sequence diagrams.
 *
 * Takes a SequenceDiagram data model (from lang/src/diagram.ts) and
 * produces an SVG string. Replaces the hardcoded mockup SVGs.
 */

// Types mirrored from lang/src/diagram.ts (avoids ESM/CJS import issues)
export type Participant = { name: string; lang?: string; isInitiator: boolean };
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
}

const COLUMN_WIDTH = 200;
const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 52;
const PADDING_X = 80;
const PADDING_Y = 16;
const FRAME_MARGIN = 12;
const FRAME_OPEN_PAD = 22;
const FRAME_CLOSE_PAD = 8;

export function renderSequenceDiagram(data: SequenceDiagramData, opts: RenderOptions = {}): string {
  const { participants, elements, protocolName, version } = data;
  if (participants.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="20" y="40" fill="#888">No participants</text></svg>';

  const partIdx = new Map<string, number>();
  participants.forEach((p, i) => partIdx.set(p.name, i));

  const px = participants.map((_, i) => PADDING_X + i * COLUMN_WIDTH);
  const totalWidth = PADDING_X * 2 + (participants.length - 1) * COLUMN_WIDTH;

  // Compute rows needed for elements
  let y = HEADER_HEIGHT + PADDING_Y;
  const rowY: number[] = [];
  const elDepths: number[] = [];
  const controlStack: Array<{ kind: string; startY: number; label: string; condition?: string; collection?: string; itemRole?: string; depth: number }> = [];
  const controlBoxes: Array<{ startY: number; endY: number; label: string; kind: string; condition?: string; collection?: string; itemRole?: string; depth: number }> = [];
  let nestDepth = 0;

  for (const el of elements) {
    switch (el.kind) {
      case "loop_start":
      case "alt_start":
      case "scatter_start":
      case "par_start":
        controlStack.push({ kind: el.kind, startY: y - 8, label: el.label, condition: el.condition, collection: el.collection, itemRole: el.itemRole, depth: nestDepth });
        nestDepth++;
        y += FRAME_OPEN_PAD;
        rowY.push(y); elDepths.push(nestDepth);
        break;
      case "loop_end":
      case "alt_end":
      case "scatter_end":
      case "par_end": {
        nestDepth = Math.max(0, nestDepth - 1);
        y += FRAME_CLOSE_PAD;
        const box = controlStack.pop();
        if (box) controlBoxes.push({ ...box, endY: y });
        y += 4;
        rowY.push(y); elDepths.push(nestDepth);
        break;
      }
      case "alt_branch":
        y += 4;
        rowY.push(y); elDepths.push(nestDepth);
        y += 12;
        break;
      default:
        rowY.push(y); elDepths.push(nestDepth);
        y += ROW_HEIGHT;
        break;
    }
  }

  const totalHeight = y + PADDING_Y;
  const sourceFile = opts.sourceFile ?? '';

  let svg = `<svg viewBox="0 0 ${totalWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">\n`;

  // Version badge
  if (version) {
    svg += `<text x="${totalWidth - 10}" y="16" text-anchor="end" class="version-badge">v${esc(version)}</text>\n`;
  }

  // Participant headers
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const x = px[i];
    const headerW = Math.max(100, p.name.length * 8.5 + 32);
    const headerH = 34;
    svg += `<rect x="${x - headerW / 2}" y="10" width="${headerW}" height="${headerH}" rx="6" class="participant-box"/>`;
    svg += `<text x="${x}" y="31" class="participant-label">${esc(p.name)}`;
    if (p.lang) svg += ` <tspan class="lang-tag">[${esc(p.lang)}]</tspan>`;
    svg += `</text>`;
    svg += `<line x1="${x}" y1="${10 + headerH}" x2="${x}" y2="${totalHeight - 8}" class="lifeline"/>`;
  }

  // Control boxes (loop, alt, scatter, par) — nested with increasing margins
  for (const box of controlBoxes) {
    const margin = box.depth * FRAME_MARGIN;
    const leftX = px[0] - 70 + margin;
    const rightX = px[px.length - 1] + 70 - margin;
    const cls = boxClass(box.kind);
    svg += `<rect x="${leftX}" y="${box.startY}" width="${rightX - leftX}" height="${box.endY - box.startY}" rx="5" class="control-box ${cls}"/>`;
    let label = box.label;
    if (box.condition) label += `  [${box.condition}]`;
    if (box.collection) label += `  over ${box.collection}`;
    if (box.itemRole) label += ` as ${box.itemRole}`;
    const tagW = Math.min(label.length * 7 + 20, rightX - leftX);
    svg += `<rect x="${leftX}" y="${box.startY}" width="${tagW}" height="20" rx="5 5 0 0" class="control-tag ${cls}"/>`;
    svg += `<text x="${leftX + 10}" y="${box.startY + 14}" class="control-label ${cls}">${esc(label)}</text>`;
  }

  // Elements
  let rowIdx = 0;
  for (const el of elements) {
    const cy = rowY[rowIdx];
    rowIdx++;

    const debug = debugClass(el.stateId, opts);
    const srcAttr = sourceAttr(el.stateId, sourceFile, opts.sourceMap);

    switch (el.kind) {
      case "message": {
        const fromI = partIdx.get(el.from ?? '') ?? 0;
        const toI = partIdx.get(el.to ?? '') ?? 0;
        const x1 = px[fromI];
        const x2 = px[toI];
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" class="msg-arrow" marker-end="url(#arrowhead)"/>`;
        svg += `<text x="${(x1 + x2) / 2}" y="${cy - 8}" class="msg-label">${esc(el.label)}</text>`;
        if (el.async) svg += `<text x="${(x1 + x2) / 2 + 4}" y="${cy - 8}" class="async-badge">⚡</text>`;
        svg += `</g>`;
        break;
      }
      case "action": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        const actionText = el.label || "action";
        const boxW = Math.max(70, Math.min(160, actionText.length * 6 + 18));
        const boxH = 22;
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - boxW / 2}" y="${cy - boxH / 2}" width="${boxW}" height="${boxH}" rx="${boxH / 2}" class="action-box"/>`;
        svg += `<text x="${cx}" y="${cy + 3.5}" class="action-label">${esc(actionText)}</text>`;
        if (el.async) svg += `<text x="${cx + boxW / 2 + 3}" y="${cy + 3}" class="async-badge">⚡</text>`;
        svg += `</g>`;
        break;
      }
      case "timer": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        const timerW = Math.max(70, Math.min(120, el.label.length * 6.5 + 30));
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - timerW / 2}" y="${cy - 9}" width="${timerW}" height="18" rx="9" class="timer-box"/>`;
        svg += `<text x="${cx}" y="${cy + 3.5}" class="timer-label">⏱ ${esc(el.label)}</text>`;
        svg += `</g>`;
        break;
      }
      case "invoke": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        const invokeW = Math.max(100, Math.min(150, el.label.length * 6 + 24));
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - invokeW / 2}" y="${cy - 11}" width="${invokeW}" height="22" rx="3" class="invoke-box"/>`;
        svg += `<rect x="${cx - invokeW / 2 + 3}" y="${cy - 8}" width="${invokeW - 6}" height="16" rx="2" class="invoke-box-inner"/>`;
        svg += `<text x="${cx}" y="${cy + 3.5}" class="invoke-label">${esc(el.label)}</text>`;
        svg += `</g>`;
        break;
      }
      case "spawn": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        const spawnW = Math.max(100, Math.min(150, el.label.length * 6 + 24));
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - spawnW / 2}" y="${cy - 11}" width="${spawnW}" height="22" rx="3" class="spawn-box" stroke-dasharray="5 3"/>`;
        svg += `<text x="${cx}" y="${cy + 3.5}" class="spawn-label">${esc(el.label)}</text>`;
        svg += `</g>`;
        break;
      }
      case "alt_branch": {
        const altMargin = elDepths[rowIdx - 1] * FRAME_MARGIN;
        const altLeftX = px[0] - 60 + altMargin;
        const altRightX = px[px.length - 1] + 60 - altMargin;
        svg += `<line x1="${altLeftX}" y1="${cy}" x2="${altRightX}" y2="${cy}" class="alt-divider"/>`;
        if (el.condition) {
          svg += `<text x="${altLeftX + 10}" y="${cy + 14}" class="control-label">[${esc(el.condition)}]</text>`;
        }
        break;
      }
      // loop_start/end, alt_start/end, scatter_start/end, par_start/end: handled by controlBoxes
      default:
        break;
    }
  }

  svg += arrowDefs();
  svg += `</svg>`;
  return svg;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function boxClass(kind: string): string {
  if (kind === "loop_start") return "loop-box";
  if (kind === "alt_start") return "alt-box";
  if (kind === "scatter_start") return "scatter-box";
  if (kind === "par_start") return "par-box";
  return "";
}

function debugClass(stateId: string | undefined, opts: RenderOptions): string {
  if (!opts.debug || !stateId) return "";
  if (opts.debug.activeStateId === stateId) return "active";
  if (opts.debug.visitedStateIds?.has(stateId)) return "visited";
  return "future";
}

function sourceAttr(stateId: string | undefined, file: string, sourceMap?: Map<string, number>): string {
  let attr = stateId ? `data-state-id="${esc(stateId)}"` : "";
  if (stateId && sourceMap) {
    const line = sourceMap.get(stateId);
    if (line != null) {
      attr += ` data-src-line="${line}" data-src-file="${esc(file)}"`;
    }
  }
  return attr;
}

function arrowDefs(): string {
  return `<defs>
  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
    <polygon points="0 0, 10 3.5, 0 7" class="arrowhead-fill"/>
  </marker>
  <marker id="arrowhead-dashed" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
    <polygon points="0 0, 10 3.5, 0 7" class="arrowhead-fill-dashed"/>
  </marker>
</defs>`;
}

/** CSS for sequence diagrams — injected into the webview */
export const SEQUENCE_DIAGRAM_CSS = `
  svg { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }

  .participant-box { fill: var(--vscode-sideBar-background, #252526); stroke: var(--vscode-panel-border, #555); stroke-width: 1.2; }
  .participant-label { text-anchor: middle; font-size: 11px; font-weight: 600; fill: var(--vscode-foreground, #d4d4d4); }
  .lang-tag { font-size: 9px; fill: var(--vscode-descriptionForeground, #888); font-weight: 400; }
  .lifeline { stroke: var(--vscode-panel-border, #3a3a3a); stroke-width: 0.8; stroke-dasharray: 4 4; }

  .msg-arrow { stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.2; }
  .msg-label { text-anchor: middle; font-size: 10px; font-weight: 500; fill: var(--vscode-charts-blue, #4fc1ff); }

  .action-box { fill: rgba(177, 128, 215, 0.10); stroke: var(--vscode-charts-purple, #b180d7); stroke-width: 0.8; }
  .action-label { text-anchor: middle; font-size: 9.5px; font-weight: 500; fill: #c898e0; letter-spacing: 0.2px; }

  .timer-box { fill: rgba(204, 167, 0, 0.08); stroke: var(--vscode-charts-yellow, #cca700); stroke-width: 0.8; }
  .timer-label { text-anchor: middle; font-size: 9px; fill: var(--vscode-charts-yellow, #cca700); }

  .invoke-box { fill: rgba(79, 193, 255, 0.06); stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.2; }
  .invoke-box-inner { fill: none; stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 0.4; }
  .invoke-label { text-anchor: middle; font-size: 9.5px; fill: var(--vscode-charts-blue, #4fc1ff); }
  .spawn-box { fill: rgba(137, 209, 133, 0.06); stroke: var(--vscode-charts-green, #89d185); stroke-width: 0.8; }
  .spawn-label { text-anchor: middle; font-size: 9.5px; fill: var(--vscode-charts-green, #89d185); }
  .async-badge { font-size: 8px; fill: var(--vscode-charts-yellow, #cca700); }
  .version-badge { font-size: 9px; fill: var(--vscode-descriptionForeground, #888); }

  .control-box { fill: none; stroke-width: 0.8; }
  .loop-box { stroke: rgba(137, 209, 133, 0.45); }
  .alt-box { stroke: rgba(209, 134, 22, 0.45); }
  .scatter-box { stroke: rgba(241, 76, 76, 0.45); }
  .par-box { stroke: rgba(177, 128, 215, 0.45); }

  .control-tag { stroke: none; }
  .control-tag.loop-box { fill: rgba(137, 209, 133, 0.12); }
  .control-tag.alt-box { fill: rgba(209, 134, 22, 0.12); }
  .control-tag.scatter-box { fill: rgba(241, 76, 76, 0.12); }
  .control-tag.par-box { fill: rgba(177, 128, 215, 0.12); }

  .control-label { font-size: 9px; font-weight: 600; letter-spacing: 0.3px; }
  .control-label.loop-box { fill: var(--vscode-charts-green, #89d185); }
  .control-label.alt-box { fill: var(--vscode-charts-orange, #d18616); }
  .control-label.scatter-box { fill: var(--vscode-charts-red, #f14c4c); }
  .control-label.par-box { fill: var(--vscode-charts-purple, #b180d7); }

  .alt-divider { stroke: var(--vscode-panel-border, #555); stroke-width: 0.5; stroke-dasharray: 4 3; }
  .arrowhead-fill { fill: var(--vscode-charts-blue, #4fc1ff); }
  .arrowhead-fill-dashed { fill: var(--vscode-charts-green, #89d185); }

  .step { cursor: pointer; transition: opacity 0.15s ease; }
  .step:hover .msg-arrow { stroke-width: 2; }
  .step:hover .action-box { stroke-width: 1.2; filter: brightness(1.15); }
  .step.visited .msg-arrow, .step.visited .msg-label { opacity: 0.35; }
  .step.visited .action-box, .step.visited .action-label { opacity: 0.35; }
  .step.active .msg-arrow { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 2; animation: pulse-line 1.5s ease-in-out infinite; }
  .step.active .msg-label { fill: var(--vscode-debugIcon-startForeground, #89d185); }
  .step.active .action-box { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 1.5; animation: pulse-box 1.5s ease-in-out infinite; }
  .step.future .msg-arrow, .step.future .msg-label, .step.future .action-box, .step.future .action-label { opacity: 0.2; }

  @keyframes pulse-line { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.5} }
  @keyframes pulse-box { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.4} }
`;
