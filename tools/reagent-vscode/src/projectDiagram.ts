/**
 * projectDiagram.ts — Reagent project-level architecture diagram.
 *
 * Scans all .rg files in a project to extract protocols, roles, and agents,
 * then renders an SVG graph showing relationships:
 *   - Protocol nodes (with participant roles)
 *   - Role nodes (with `plays` bindings)
 *   - Agent nodes (with `runs` bindings)
 *   - Edges: agent --runs--> role --plays-as--> protocol
 */

export interface ProjectNode {
  id: string;
  kind: 'protocol' | 'role' | 'agent';
  name: string;
  lang?: string;
  file: string;
  line: number;
  participants?: Array<{ name: string; lang?: string }>;
  plays?: Array<{ protocol: string; as: string }>;
  inits?: string[];
  runs?: string;
}

export interface ProjectEdge {
  from: string;
  to: string;
  label: string;
  kind: 'plays' | 'runs' | 'participates';
}

export interface ProjectDiagramData {
  projectName: string;
  nodes: ProjectNode[];
  edges: ProjectEdge[];
}

// Regex-based lightweight scanner — no full parse needed
const RE_PROTOCOL = /^protocol\s+(\w+)\s*\{/gm;
const RE_PARTICIPANTS = /participants\s*:\s*(.+)/;
const RE_ROLE = /^role\s+(\w+)(?:\s+\[(\w+)\])?\s*\{/gm;
const RE_PLAYS = /plays\s+(\w+)\s+as\s+(\w+)/g;
const RE_AGENT = /^agent\s+(\w+)\s+runs\s+(\w+)/gm;

export function scanReagentFile(source: string, filePath: string): {
  protocols: ProjectNode[];
  roles: ProjectNode[];
  agents: ProjectNode[];
} {
  const protocols: ProjectNode[] = [];
  const roles: ProjectNode[] = [];
  const agents: ProjectNode[] = [];
  const lines = source.split('\n');

  // Scan protocols
  RE_PROTOCOL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PROTOCOL.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    const name = m[1];
    const participants: Array<{ name: string; lang?: string }> = [];

    // Find participants line within protocol block
    const blockStart = m.index;
    const blockLines = source.substring(blockStart).split('\n');
    for (const bl of blockLines.slice(0, 10)) {
      const pm = RE_PARTICIPANTS.exec(bl);
      if (pm) {
        const parts = pm[1].split(',');
        for (const p of parts) {
          const trimmed = p.trim();
          const langMatch = trimmed.match(/^(\w+)\s+\[(\w+)\]/);
          if (langMatch) {
            participants.push({ name: langMatch[1], lang: langMatch[2] });
          } else {
            const nameOnly = trimmed.match(/^(\w+)/);
            if (nameOnly) participants.push({ name: nameOnly[1] });
          }
        }
        break;
      }
    }

    protocols.push({
      id: `protocol:${name}`,
      kind: 'protocol',
      name,
      file: filePath,
      line,
      participants,
    });
  }

  // Scan roles
  RE_ROLE.lastIndex = 0;
  while ((m = RE_ROLE.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    const name = m[1];
    const lang = m[2];
    const plays: Array<{ protocol: string; as: string }> = [];

    // Extract plays declarations from the role block
    let braceCount = 0;
    let blockContent = '';
    for (let i = m.index; i < source.length; i++) {
      if (source[i] === '{') braceCount++;
      if (source[i] === '}') { braceCount--; if (braceCount === 0) { blockContent = source.substring(m.index, i + 1); break; } }
    }

    RE_PLAYS.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = RE_PLAYS.exec(blockContent)) !== null) {
      plays.push({ protocol: pm[1], as: pm[2] });
    }

    roles.push({
      id: `role:${name}`,
      kind: 'role',
      name,
      lang,
      file: filePath,
      line,
      plays,
    });
  }

  // Scan agents
  RE_AGENT.lastIndex = 0;
  while ((m = RE_AGENT.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    agents.push({
      id: `agent:${m[1]}`,
      kind: 'agent',
      name: m[1],
      file: filePath,
      line,
      runs: m[2],
    });
  }

  return { protocols, roles, agents };
}

export function buildProjectDiagram(
  projectName: string,
  fileContents: Map<string, string>,
): ProjectDiagramData {
  const allNodes: ProjectNode[] = [];
  const allEdges: ProjectEdge[] = [];
  const seenProtocols = new Set<string>();

  for (const [filePath, source] of fileContents) {
    const { protocols, roles, agents } = scanReagentFile(source, filePath);

    for (const p of protocols) {
      if (!seenProtocols.has(p.name)) {
        allNodes.push(p);
        seenProtocols.add(p.name);
      }
    }
    allNodes.push(...roles);
    allNodes.push(...agents);
  }

  // Build edges
  for (const node of allNodes) {
    if (node.kind === 'role' && node.plays) {
      for (const play of node.plays) {
        allEdges.push({
          from: node.id,
          to: `protocol:${play.protocol}`,
          label: `as ${play.as}`,
          kind: 'plays',
        });
      }
    }
    if (node.kind === 'agent' && node.runs) {
      allEdges.push({
        from: node.id,
        to: `role:${node.runs}`,
        label: 'runs',
        kind: 'runs',
      });
    }
  }

  return { projectName, nodes: allNodes, edges: allEdges };
}

// ── SVG Renderer ────────────────────────────────────────────────────

const COL_AGENT = 80;
const COL_ROLE = 320;
const COL_PROTOCOL = 600;
const ROW_GAP = 80;
const NODE_W = 160;
const NODE_H = 40;
const PADDING_Y = 60;

export function renderProjectDiagram(
  data: ProjectDiagramData,
  opts?: { onClickNavigate?: boolean },
): string {
  const agents = data.nodes.filter(n => n.kind === 'agent');
  const roles = data.nodes.filter(n => n.kind === 'role');
  const protocols = data.nodes.filter(n => n.kind === 'protocol');

  // Assign Y positions per column
  const pos = new Map<string, { x: number; y: number }>();
  const placeColumn = (nodes: ProjectNode[], x: number) => {
    for (let i = 0; i < nodes.length; i++) {
      pos.set(nodes[i].id, { x, y: PADDING_Y + i * ROW_GAP });
    }
  };

  placeColumn(agents, COL_AGENT);
  placeColumn(roles, COL_ROLE);
  placeColumn(protocols, COL_PROTOCOL);

  const maxRows = Math.max(agents.length, roles.length, protocols.length, 1);
  const width = COL_PROTOCOL + NODE_W + 40;
  const height = PADDING_Y + maxRows * ROW_GAP + 20;

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">\n`;

  // Column headers
  svg += `<text x="${COL_AGENT + NODE_W / 2}" y="24" class="pj-col-header">Agents</text>`;
  svg += `<text x="${COL_ROLE + NODE_W / 2}" y="24" class="pj-col-header">Roles</text>`;
  svg += `<text x="${COL_PROTOCOL + NODE_W / 2}" y="24" class="pj-col-header">Protocols</text>`;

  // Edges (draw before nodes for z-order)
  for (const edge of data.edges) {
    const fromPos = pos.get(edge.from);
    const toPos = pos.get(edge.to);
    if (!fromPos || !toPos) continue;

    const x1 = fromPos.x + NODE_W;
    const y1 = fromPos.y + NODE_H / 2;
    const x2 = toPos.x;
    const y2 = toPos.y + NODE_H / 2;

    const cls = edge.kind === 'runs' ? 'pj-edge-runs' :
                edge.kind === 'plays' ? 'pj-edge-plays' : 'pj-edge-default';

    // Curved bezier for longer edges
    const cx1 = x1 + (x2 - x1) * 0.4;
    const cx2 = x1 + (x2 - x1) * 0.6;
    svg += `<path d="M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}" class="${cls}" fill="none" marker-end="url(#pj-arrow-${edge.kind})"/>`;

    // Edge label
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 6;
    svg += `<text x="${mx}" y="${my}" class="pj-edge-label">${esc(edge.label)}</text>`;
  }

  // Nodes
  for (const node of data.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const { x, y } = p;

    const srcAttr = `data-src-file="${esc(node.file)}" data-src-line="${node.line}"`;
    const cls = `pj-node pj-${node.kind}`;

    svg += `<g class="${cls}" ${srcAttr}>`;

    if (node.kind === 'protocol') {
      // Rounded rect with double border
      svg += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="6" class="pj-proto-box"/>`;
      svg += `<rect x="${x + 3}" y="${y + 3}" width="${NODE_W - 6}" height="${NODE_H - 6}" rx="4" class="pj-proto-box-inner"/>`;
      svg += `<text x="${x + NODE_W / 2}" y="${y + NODE_H / 2 + 5}" class="pj-proto-label">${esc(node.name)}</text>`;

      // Participant pills below
      if (node.participants && node.participants.length > 0) {
        const pillY = y + NODE_H + 4;
        const pillW = Math.min(40, (NODE_W - 4) / node.participants.length - 2);
        const startX = x + (NODE_W - node.participants.length * (pillW + 4)) / 2;
        for (let i = 0; i < node.participants.length; i++) {
          const px = startX + i * (pillW + 4);
          svg += `<rect x="${px}" y="${pillY}" width="${pillW}" height="14" rx="7" class="pj-participant-pill"/>`;
          svg += `<text x="${px + pillW / 2}" y="${pillY + 10}" class="pj-participant-text">${esc(node.participants[i].name)}</text>`;
        }
      }
    } else if (node.kind === 'role') {
      // Hexagon
      const cx = x + NODE_W / 2;
      const cy = y + NODE_H / 2;
      const hw = NODE_W / 2;
      const hh = NODE_H / 2;
      const inset = 16;
      svg += `<polygon points="${x + inset},${y} ${x + NODE_W - inset},${y} ${x + NODE_W},${cy} ${x + NODE_W - inset},${y + NODE_H} ${x + inset},${y + NODE_H} ${x},${cy}" class="pj-role-box"/>`;
      svg += `<text x="${cx}" y="${cy + 5}" class="pj-role-label">${esc(node.name)}</text>`;
      if (node.lang) {
        svg += `<text x="${cx}" y="${cy + 17}" class="pj-role-lang">[${esc(node.lang)}]</text>`;
      }
    } else if (node.kind === 'agent') {
      // Rounded pill
      svg += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="${NODE_H / 2}" class="pj-agent-box"/>`;
      svg += `<text x="${x + NODE_W / 2}" y="${y + NODE_H / 2 + 5}" class="pj-agent-label">${esc(node.name)}</text>`;
    }

    svg += `</g>`;
  }

  svg += projectArrowDefs();
  svg += `</svg>`;
  return svg;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function projectArrowDefs(): string {
  return `<defs>
  <marker id="pj-arrow-runs" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="#89d185"/>
  </marker>
  <marker id="pj-arrow-plays" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="#4fc1ff"/>
  </marker>
  <marker id="pj-arrow-participates" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="#d18616"/>
  </marker>
</defs>`;
}

export const PROJECT_DIAGRAM_CSS = `
  .pj-col-header { text-anchor: middle; font-size: 12px; font-weight: 700; fill: var(--vscode-descriptionForeground, #888); text-transform: uppercase; letter-spacing: 1px; }

  .pj-proto-box { fill: #1a2a3a; stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }
  .pj-proto-box-inner { fill: none; stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 0.5; }
  .pj-proto-label { text-anchor: middle; font-size: 12px; font-weight: 600; fill: var(--vscode-charts-blue, #4fc1ff); }
  .pj-participant-pill { fill: #0e2840; stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 0.8; }
  .pj-participant-text { text-anchor: middle; font-size: 7px; fill: #7abfdb; }

  .pj-role-box { fill: #1a3d1a; stroke: var(--vscode-charts-green, #89d185); stroke-width: 1.5; }
  .pj-role-label { text-anchor: middle; font-size: 12px; font-weight: 600; fill: var(--vscode-charts-green, #89d185); }
  .pj-role-lang { text-anchor: middle; font-size: 9px; fill: var(--vscode-descriptionForeground, #888); }

  .pj-agent-box { fill: #3d2800; stroke: var(--vscode-charts-orange, #d18616); stroke-width: 1.5; }
  .pj-agent-label { text-anchor: middle; font-size: 12px; font-weight: 600; fill: var(--vscode-charts-orange, #d18616); }

  .pj-edge-runs { stroke: var(--vscode-charts-green, #89d185); stroke-width: 1.5; }
  .pj-edge-plays { stroke: var(--vscode-charts-blue, #4fc1ff); stroke-width: 1.5; }
  .pj-edge-default { stroke: var(--vscode-panel-border, #555); stroke-width: 1; }
  .pj-edge-label { text-anchor: middle; font-size: 9px; fill: var(--vscode-descriptionForeground, #999); }

  .pj-node { cursor: pointer; }
  .pj-node:hover .pj-proto-box,
  .pj-node:hover .pj-role-box,
  .pj-node:hover .pj-agent-box { filter: brightness(1.3); }
`;
