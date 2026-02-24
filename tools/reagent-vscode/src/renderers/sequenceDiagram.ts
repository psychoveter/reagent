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

const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 70;
const PADDING_X = 90;
const PADDING_Y = 40;
const FRAME_MARGIN = 16;
const FRAME_OPEN_PAD = 30;   // vertical space after control-box label before first inner element
const FRAME_CLOSE_PAD = 16;  // vertical space after last inner element before control-box bottom

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
        controlStack.push({ kind: el.kind, startY: y - 10, label: el.label, condition: el.condition, collection: el.collection, itemRole: el.itemRole, depth: nestDepth });
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
        y += 8;
        rowY.push(y); elDepths.push(nestDepth);
        break;
      }
      case "alt_branch":
        y += 6;
        rowY.push(y); elDepths.push(nestDepth);
        y += 16;
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
    const headerW = Math.max(110, p.name.length * 9 + 40);
    svg += `<rect x="${x - headerW / 2}" y="10" width="${headerW}" height="40" rx="6" class="participant-box"/>`;
    svg += `<text x="${x}" y="35" class="participant-label">${esc(p.name)}`;
    if (p.lang) svg += ` <tspan class="lang-tag">[${esc(p.lang)}]</tspan>`;
    svg += `</text>`;
    svg += `<line x1="${x}" y1="50" x2="${x}" y2="${totalHeight - 10}" class="lifeline"/>`;
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
        const boxW = Math.max(90, Math.min(180, actionText.length * 6.5 + 20));
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - boxW / 2}" y="${cy - 12}" width="${boxW}" height="24" rx="4" class="action-box"/>`;
        svg += `<text x="${cx}" y="${cy + 3}" class="action-label">${esc(actionText)}</text>`;
        if (el.async) svg += `<text x="${cx + boxW / 2 + 4}" y="${cy + 3}" class="async-badge">⚡</text>`;
        svg += `</g>`;
        break;
      }
      case "timer": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - 45}" y="${cy - 10}" width="90" height="20" rx="10" class="timer-box"/>`;
        svg += `<text x="${cx}" y="${cy + 4}" class="timer-label">⏱ ${esc(el.label)}</text>`;
        svg += `</g>`;
        break;
      }
      case "invoke": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - 70}" y="${cy - 12}" width="140" height="24" rx="3" class="invoke-box"/>`;
        svg += `<rect x="${cx - 67}" y="${cy - 9}" width="134" height="18" rx="2" class="invoke-box-inner"/>`;
        svg += `<text x="${cx}" y="${cy + 4}" class="invoke-label">${esc(el.label)}</text>`;
        svg += `</g>`;
        break;
      }
      case "spawn": {
        const ri = partIdx.get(el.role) ?? 0;
        const cx = px[ri];
        svg += `<g class="step ${debug}" ${srcAttr}>`;
        svg += `<rect x="${cx - 70}" y="${cy - 12}" width="140" height="24" rx="3" class="spawn-box" stroke-dasharray="5 3"/>`;
        svg += `<text x="${cx}" y="${cy + 4}" class="spawn-label">${esc(el.label)}</text>`;
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
  if (!stateId || !sourceMap) return "";
  const line = sourceMap.get(stateId);
  if (line == null) return "";
  return `data-src-line="${line}" data-src-file="${esc(file)}"`;
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

  .participant-box { fill: var(--vscode-sideBar-background, #252526); stroke: var(--vscode-panel-border, #555); stroke-width: 1.5; }
  .participant-label { text-anchor: middle; font-size: 12px; font-weight: 600; fill: var(--vscode-foreground, #d4d4d4); }
  .lang-tag { font-size: 10px; fill: var(--vscode-descriptionForeground, #888); font-weight: 400; }
  .lifeline { stroke: var(--vscode-panel-border, #3a3a3a); stroke-width: 1; stroke-dasharray: 5 4; }

  .msg-arrow { stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }
  .msg-label { text-anchor: middle; font-size: 11px; font-weight: 500; fill: var(--vscode-charts-blue, #4fc1ff); }

  .action-box { fill: rgba(177, 128, 215, 0.08); stroke: var(--vscode-charts-purple, #b180d7); stroke-width: 1; }
  .action-label { text-anchor: middle; font-size: 10px; font-weight: 500; fill: #c898e0; letter-spacing: 0.2px; }

  .timer-box { fill: rgba(204, 167, 0, 0.08); stroke: var(--vscode-charts-yellow, #cca700); stroke-width: 1; }
  .timer-label { text-anchor: middle; font-size: 10px; fill: var(--vscode-charts-yellow, #cca700); }

  .invoke-box { fill: rgba(79, 193, 255, 0.06); stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }
  .invoke-box-inner { fill: none; stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 0.5; }
  .invoke-label { text-anchor: middle; font-size: 10px; fill: var(--vscode-charts-blue, #4fc1ff); }
  .spawn-box { fill: rgba(137, 209, 133, 0.06); stroke: var(--vscode-charts-green, #89d185); stroke-width: 1; }
  .spawn-label { text-anchor: middle; font-size: 10px; fill: var(--vscode-charts-green, #89d185); }
  .async-badge { font-size: 9px; fill: var(--vscode-charts-yellow, #cca700); }
  .version-badge { font-size: 10px; fill: var(--vscode-descriptionForeground, #888); }

  .control-box { fill: none; stroke-width: 1; }
  .loop-box { stroke: rgba(137, 209, 133, 0.5); }
  .alt-box { stroke: rgba(209, 134, 22, 0.5); }
  .scatter-box { stroke: rgba(241, 76, 76, 0.5); }
  .par-box { stroke: rgba(177, 128, 215, 0.5); }

  .control-tag { stroke: none; }
  .control-tag.loop-box { fill: rgba(137, 209, 133, 0.15); }
  .control-tag.alt-box { fill: rgba(209, 134, 22, 0.15); }
  .control-tag.scatter-box { fill: rgba(241, 76, 76, 0.15); }
  .control-tag.par-box { fill: rgba(177, 128, 215, 0.15); }

  .control-label { font-size: 10px; font-weight: 600; letter-spacing: 0.3px; }
  .control-label.loop-box { fill: var(--vscode-charts-green, #89d185); }
  .control-label.alt-box { fill: var(--vscode-charts-orange, #d18616); }
  .control-label.scatter-box { fill: var(--vscode-charts-red, #f14c4c); }
  .control-label.par-box { fill: var(--vscode-charts-purple, #b180d7); }

  .alt-divider { stroke: var(--vscode-panel-border, #555); stroke-width: 0.5; stroke-dasharray: 4 3; }
  .arrowhead-fill { fill: var(--vscode-charts-blue, #4fc1ff); }
  .arrowhead-fill-dashed { fill: var(--vscode-charts-green, #89d185); }

  .step { cursor: pointer; }
  .step:hover .msg-arrow { stroke-width: 2.5; }
  .step:hover .action-box { stroke-width: 1.5; filter: brightness(1.2); }
  .step.visited .msg-arrow, .step.visited .msg-label { opacity: 0.35; }
  .step.visited .action-box, .step.visited .action-label { opacity: 0.35; }
  .step.active .msg-arrow { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 2.5; animation: pulse-line 1.5s ease-in-out infinite; }
  .step.active .msg-label { fill: var(--vscode-debugIcon-startForeground, #89d185); }
  .step.active .action-box { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 2; animation: pulse-box 1.5s ease-in-out infinite; }
  .step.future .msg-arrow, .step.future .msg-label, .step.future .action-box, .step.future .action-label { opacity: 0.2; }

  @keyframes pulse-line { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.5} }
  @keyframes pulse-box { 0%,100%{stroke-opacity:1} 50%{stroke-opacity:0.4} }
`;
