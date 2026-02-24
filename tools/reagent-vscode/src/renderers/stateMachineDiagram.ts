/**
 * stateMachineDiagram.ts — SVG renderer for per-role state machine diagrams.
 *
 * Takes a StateMachineDiagram data model (from lang/src/diagram.ts) and
 * produces an SVG string using a simple layered layout algorithm.
 * Nodes are assigned to layers via topological ordering, then positioned.
 */

// Types mirrored from lang/src/diagram.ts
export type SmNodeShape = "circle" | "rect" | "diamond" | "hexagon" | "double-rect" | "pill";

export type SmNode = {
  id: string;
  kind: string;
  label: string;
  shape: SmNodeShape;
  stateId: string;
};

export type SmEdge = {
  from: string;
  to: string;
  label?: string;
};

export interface StateMachineDiagramData {
  protocolName: string;
  role: string;
  nodes: SmNode[];
  edges: SmEdge[];
}

export interface SmRenderOptions {
  sourceFile?: string;
  sourceMap?: Map<string, number>;
  debug?: {
    activeStateId?: string;
    visitedStateIds?: Set<string>;
  };
}

interface LayoutNode {
  id: string;
  node: SmNode;
  x: number;
  y: number;
  layer: number;
  order: number;
}

const NODE_W = 140;
const NODE_H = 36;
const LAYER_GAP = 70;
const NODE_GAP = 40;
const PADDING = 40;

export function renderStateMachineDiagram(data: StateMachineDiagramData, opts: SmRenderOptions = {}): string {
  const { nodes, edges, protocolName, role } = data;
  if (nodes.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="20" y="40" fill="#888">No states</text></svg>';
  }

  const layoutNodes = computeLayout(nodes, edges);
  const nodeMap = new Map<string, LayoutNode>();
  for (const ln of layoutNodes) nodeMap.set(ln.id, ln);

  // Compute SVG dimensions
  let maxX = 0, maxY = 0;
  for (const ln of layoutNodes) {
    maxX = Math.max(maxX, ln.x + NODE_W / 2);
    maxY = Math.max(maxY, ln.y + NODE_H / 2);
  }
  const width = maxX + PADDING * 2;
  const height = maxY + PADDING * 2;

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">\n`;

  // Title
  svg += `<text x="10" y="18" class="sm-title">${esc(protocolName)} / ${esc(role)}</text>\n`;

  // Edges
  for (const edge of edges) {
    const fromLn = nodeMap.get(edge.from);
    const toLn = nodeMap.get(edge.to);
    if (!fromLn || !toLn) continue;

    const x1 = fromLn.x;
    const y1 = fromLn.y + NODE_H / 2;
    const x2 = toLn.x;
    const y2 = toLn.y - NODE_H / 2;

    const isBackEdge = toLn.layer <= fromLn.layer;

    if (isBackEdge) {
      // Back edge: curve to the right
      const cx = Math.max(x1, x2) + 50;
      svg += `<path d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}" class="sm-edge sm-back-edge" marker-end="url(#sm-arrow)" fill="none"/>`;
    } else {
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="sm-edge" marker-end="url(#sm-arrow)"/>`;
    }

    if (edge.label) {
      const mx = (x1 + x2) / 2 + (isBackEdge ? 25 : 8);
      const my = (y1 + y2) / 2;
      svg += `<text x="${mx}" y="${my}" class="sm-edge-label">${esc(edge.label)}</text>`;
    }
  }

  // Nodes
  for (const ln of layoutNodes) {
    const n = ln.node;
    const x = ln.x;
    const y = ln.y;
    const debug = smDebugClass(n.stateId, opts);
    const srcAttr = smSourceAttr(n.stateId, opts.sourceFile ?? '', opts.sourceMap);

    svg += `<g class="sm-node ${debug}" ${srcAttr}>`;

    switch (n.shape) {
      case "circle":
        if (n.kind === "initial") {
          svg += `<circle cx="${x}" cy="${y}" r="14" class="sm-circle sm-initial"/>`;
          svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">●</text>`;
        } else {
          svg += `<circle cx="${x}" cy="${y}" r="14" class="sm-circle sm-terminal"/>`;
          svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">◉</text>`;
        }
        break;
      case "diamond":
        svg += `<polygon points="${x},${y - 20} ${x + 30},${y} ${x},${y + 20} ${x - 30},${y}" class="sm-diamond sm-guard"/>`;
        svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">${esc(n.label)}</text>`;
        break;
      case "hexagon": {
        const hw = NODE_W / 2;
        const hh = NODE_H / 2;
        const inset = 12;
        svg += `<polygon points="${x - hw + inset},${y - hh} ${x + hw - inset},${y - hh} ${x + hw},${y} ${x + hw - inset},${y + hh} ${x - hw + inset},${y + hh} ${x - hw},${y}" class="sm-hexagon sm-scatter"/>`;
        svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">${esc(n.label)}</text>`;
        break;
      }
      case "double-rect":
        svg += `<rect x="${x - NODE_W / 2}" y="${y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="4" class="sm-rect sm-invoke"/>`;
        svg += `<rect x="${x - NODE_W / 2 + 3}" y="${y - NODE_H / 2 + 3}" width="${NODE_W - 6}" height="${NODE_H - 6}" rx="2" class="sm-rect-inner sm-invoke"/>`;
        svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">${esc(n.label)}</text>`;
        break;
      case "pill":
        svg += `<rect x="${x - NODE_W / 2}" y="${y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="${NODE_H / 2}" class="sm-rect sm-timer"/>`;
        svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">${esc(n.label)}</text>`;
        break;
      default: {
        const cls = n.kind === "send" ? "sm-send" :
                    n.kind === "receive" ? "sm-receive" :
                    n.kind === "action" ? "sm-action" :
                    "sm-default";
        svg += `<rect x="${x - NODE_W / 2}" y="${y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="4" class="sm-rect ${cls}"/>`;
        svg += `<text x="${x}" y="${y + 5}" class="sm-label-center">${esc(n.label)}</text>`;
        break;
      }
    }

    svg += `</g>`;
  }

  svg += smArrowDefs();
  svg += `</svg>`;
  return svg;
}

// ── Layout Algorithm ───────────────────────────────────────────────

function computeLayout(nodes: SmNode[], edges: SmEdge[]): LayoutNode[] {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    nodeIds.add(n.id);
    adj.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  // Filter back-edges for layer assignment
  const forwardEdges: SmEdge[] = [];
  const backEdgeSet = new Set<string>();
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(u: string): void {
    visited.add(u);
    recStack.add(u);
    for (const e of edges) {
      if (e.from !== u) continue;
      if (!nodeIds.has(e.to)) continue;
      if (recStack.has(e.to)) {
        backEdgeSet.add(`${e.from}->${e.to}`);
      } else if (!visited.has(e.to)) {
        dfs(e.to);
      }
    }
    recStack.delete(u);
  }

  // Find initial node to start DFS
  const initialNode = nodes.find(n => n.kind === "initial");
  if (initialNode) dfs(initialNode.id);
  for (const n of nodes) {
    if (!visited.has(n.id)) dfs(n.id);
  }

  for (const e of edges) {
    if (backEdgeSet.has(`${e.from}->${e.to}`)) continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    forwardEdges.push(e);
    adj.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  // Topological sort with layer assignment
  const layers = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) {
      queue.push(id);
      layers.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const u = queue.shift()!;
    const uLayer = layers.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      const newLayer = Math.max(layers.get(v) ?? 0, uLayer + 1);
      layers.set(v, newLayer);
      inDeg.set(v, (inDeg.get(v) ?? 0) - 1);
      if (inDeg.get(v) === 0) queue.push(v);
    }
  }

  // Assign unvisited nodes (cycles) to their own layers
  for (const n of nodes) {
    if (!layers.has(n.id)) layers.set(n.id, (layers.size));
  }

  // Group by layer
  const layerGroups = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    const arr = layerGroups.get(layer) ?? [];
    arr.push(id);
    layerGroups.set(layer, arr);
  }

  // Position nodes
  const nodeMapById = new Map<string, SmNode>();
  for (const n of nodes) nodeMapById.set(n.id, n);

  const layoutNodes: LayoutNode[] = [];
  for (const [layer, ids] of layerGroups) {
    const layerWidth = ids.length * (NODE_W + NODE_GAP) - NODE_GAP;
    const startX = PADDING + (NODE_W + NODE_GAP) / 2;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const node = nodeMapById.get(id);
      if (!node) continue;
      layoutNodes.push({
        id,
        node,
        x: startX + i * (NODE_W + NODE_GAP),
        y: PADDING + 20 + layer * LAYER_GAP,
        layer,
        order: i,
      });
    }
  }

  return layoutNodes;
}

// ── Helpers ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function smDebugClass(stateId: string, opts: SmRenderOptions): string {
  if (!opts.debug) return "";
  if (opts.debug.activeStateId === stateId) return "active";
  if (opts.debug.visitedStateIds?.has(stateId)) return "visited";
  return "future";
}

function smSourceAttr(stateId: string, file: string, sourceMap?: Map<string, number>): string {
  if (!sourceMap) return "";
  const line = sourceMap.get(stateId);
  if (line == null) return "";
  return `data-src-line="${line}" data-src-file="${esc(file)}"`;
}

function smArrowDefs(): string {
  return `<defs>
  <marker id="sm-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" class="arrowhead-fill"/>
  </marker>
</defs>`;
}

/** CSS for state machine diagrams — injected into the webview */
export const STATE_MACHINE_CSS = `
  .sm-title { font-size: 12px; font-weight: 600; fill: var(--vscode-descriptionForeground, #888); }
  .sm-edge { stroke: var(--vscode-panel-border, #555); stroke-width: 1.5; }
  .sm-back-edge { stroke: var(--vscode-charts-green, #89d185); stroke-width: 1; stroke-dasharray: 4 3; }
  .sm-edge-label { font-size: 9px; fill: var(--vscode-descriptionForeground, #999); }
  .sm-circle { stroke-width: 2; }
  .sm-initial { fill: var(--vscode-foreground, #d4d4d4); stroke: var(--vscode-foreground, #d4d4d4); }
  .sm-terminal { fill: none; stroke: var(--vscode-foreground, #d4d4d4); stroke-width: 3; }
  .sm-rect { stroke-width: 1.5; }
  .sm-rect-inner { fill: none; stroke-width: 0.5; }
  .sm-send { fill: #1a3a5c; stroke: var(--vscode-charts-blue, #4fc1ff); }
  .sm-receive { fill: #3d2800; stroke: var(--vscode-charts-orange, #d18616); }
  .sm-action { fill: #2d1a4e; stroke: var(--vscode-charts-purple, #b180d7); }
  .sm-timer { fill: #3d3000; stroke: var(--vscode-charts-yellow, #cca700); }
  .sm-invoke { fill: #1a2a3a; stroke: var(--vscode-charts-blue, #4fc1ff); }
  .sm-scatter { fill: #3d1a1a; stroke: var(--vscode-charts-red, #f14c4c); }
  .sm-hexagon { stroke-width: 1.5; }
  .sm-diamond { fill: #1a3d1a; stroke: var(--vscode-charts-green, #89d185); stroke-width: 1.5; }
  .sm-default { fill: var(--vscode-editor-inactiveSelectionBackground, #3a3d41); stroke: var(--vscode-panel-border, #555); }
  .sm-label-center { text-anchor: middle; font-size: 11px; fill: var(--vscode-foreground, #d4d4d4); }
  .sm-node { cursor: pointer; }
  .sm-node:hover .sm-rect, .sm-node:hover .sm-diamond, .sm-node:hover .sm-circle, .sm-node:hover .sm-hexagon { filter: brightness(1.3); }

  .sm-node.visited .sm-rect, .sm-node.visited .sm-diamond, .sm-node.visited .sm-circle, .sm-node.visited .sm-label-center, .sm-node.visited .sm-hexagon { opacity: 0.4; }
  .sm-node.active .sm-rect, .sm-node.active .sm-diamond, .sm-node.active .sm-hexagon { stroke: var(--vscode-debugIcon-startForeground, #89d185); stroke-width: 3; animation: pulse-box 1.5s ease-in-out infinite; }
  .sm-node.active .sm-circle { stroke: var(--vscode-debugIcon-startForeground, #89d185); animation: pulse-box 1.5s ease-in-out infinite; }
  .sm-node.future .sm-rect, .sm-node.future .sm-diamond, .sm-node.future .sm-circle, .sm-node.future .sm-label-center, .sm-node.future .sm-hexagon { opacity: 0.25; }

  .arrowhead-fill { fill: var(--vscode-panel-border, #555); }
`;
