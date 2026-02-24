/**
 * diagram.ts — IR to diagram data model.
 *
 * Converts compiled IRGraphs (per-role state machines) into a unified
 * diagram model suitable for sequence diagram and state machine rendering.
 * Shared between VSCode extension and CLI.
 */

import type {
  IRGraph,
  IRState,
  IRTransition,
  IRStateKind,
  IRSendData,
  IRReceiveData,
  IRActionData,
  IRGuardData,
  IRForkData,
  IRJoinData,
  IRTimerData,
  IRScatterData,
  IRInvokeData,
  IRSpawnData,
} from "./ir.js";

// ── Sequence Diagram Model ─────────────────────────────────────────

export type Participant = {
  name: string;
  lang?: string;
  isInitiator: boolean;
};

export type SeqElementKind =
  | "message"
  | "action"
  | "timer"
  | "loop_start"
  | "loop_end"
  | "alt_start"
  | "alt_branch"
  | "alt_end"
  | "scatter_start"
  | "scatter_end"
  | "invoke"
  | "spawn"
  | "par_start"
  | "par_end";

export type SeqElement = {
  kind: SeqElementKind;
  /** Source role this element belongs to */
  role: string;
  /** State ID in IR (for sourceMap linking) */
  stateId?: string;
  /** Sending participant (messages) */
  from?: string;
  /** Receiving participant (messages) */
  to?: string;
  /** Message name, action body summary, or control label */
  label: string;
  /** For alt branches: the condition expression */
  condition?: string;
  /** For scatter: the collection expression */
  collection?: string;
  /** For scatter: the item role */
  itemRole?: string;
  /** For invoke/spawn: the protocol name */
  protocolName?: string;
  /** For timer: duration */
  duration?: { value: number; unit: string };
  /** Whether zone is async */
  async?: boolean;
  /** $flow propagation annotations */
  propagateFlow?: boolean;
};

export type SequenceDiagram = {
  protocolName: string;
  version?: string;
  participants: Participant[];
  elements: SeqElement[];
};

// ── State Machine Diagram Model ────────────────────────────────────

export type SmNodeShape = "circle" | "rect" | "diamond" | "hexagon" | "double-rect" | "pill";

export type SmNode = {
  id: string;
  kind: IRStateKind;
  label: string;
  shape: SmNodeShape;
  stateId: string;
};

export type SmEdge = {
  from: string;
  to: string;
  label?: string;
};

export type StateMachineDiagram = {
  protocolName: string;
  role: string;
  nodes: SmNode[];
  edges: SmEdge[];
};

// ── Build Sequence Diagram ─────────────────────────────────────────

/**
 * Build a sequence diagram from multiple per-role IRGraphs of the same protocol.
 * Walks the initiator's graph as the primary timeline, cross-referencing
 * other roles for receive-side information.
 */
export function buildSequenceDiagram(
  graphs: Map<string, IRGraph>,
  protocolName: string,
): SequenceDiagram {
  const participants: Participant[] = [];
  const roleSet = new Set<string>();
  let initiatorRole: string | undefined;
  let initiatorGraph: IRGraph | undefined;
  let version: string | undefined;

  for (const [key, graph] of graphs) {
    if (graph.protocolName !== protocolName) continue;
    version = version ?? graph.version;
    if (!roleSet.has(graph.role)) {
      roleSet.add(graph.role);
      const isInit = !!graph.initiator && graph.initiator === graph.role;
      participants.push({ name: graph.role, lang: graph.lang, isInitiator: isInit });
      if (isInit || !initiatorGraph) {
        initiatorRole = graph.role;
        initiatorGraph = graph;
      }
    }
  }

  if (!initiatorGraph || !initiatorRole) {
    // Fallback: use first graph
    const first = graphs.values().next().value;
    if (!first) return { protocolName, participants: [], elements: [] };
    initiatorGraph = first;
    initiatorRole = first.role;
    if (!participants.some(p => p.name === first.role)) {
      participants.push({ name: first.role, isInitiator: true });
    }
  }

  const elements: SeqElement[] = [];
  const stateMap = new Map<string, IRState>();
  for (const s of initiatorGraph.states) stateMap.set(s.id, s);
  const transFrom = buildTransFromMap(initiatorGraph.transitions);

  walkForSequence(initiatorGraph.initialStateId, stateMap, transFrom, initiatorRole, elements, new Set());

  return { protocolName, version, participants, elements };
}

function walkForSequence(
  stateId: string,
  stateMap: Map<string, IRState>,
  transFrom: Map<string, IRTransition[]>,
  role: string,
  elements: SeqElement[],
  visited: Set<string>,
): void {
  if (visited.has(stateId)) return;
  visited.add(stateId);

  const state = stateMap.get(stateId);
  if (!state) return;

  const d = state.data;
  switch (d.kind) {
    case "send": {
      const sd = d as IRSendData;
      elements.push({
        kind: "message",
        role,
        stateId: state.id,
        from: role,
        to: sd.to,
        label: sd.messageName,
        async: sd.preSendAsync,
        propagateFlow: sd.propagateFlow,
      });
      break;
    }
    case "receive": {
      const rd = d as IRReceiveData;
      elements.push({
        kind: "message",
        role,
        stateId: state.id,
        from: rd.from,
        to: role,
        label: rd.messageName,
        async: rd.postReceiveAsync,
        propagateFlow: rd.propagateFlow,
      });
      break;
    }
    case "action": {
      const ad = d as IRActionData;
      elements.push({
        kind: "action",
        role,
        stateId: state.id,
        label: summarizeZone(ad.body),
        async: ad.async,
      });
      break;
    }
    case "timer": {
      const td = d as IRTimerData;
      elements.push({
        kind: "timer",
        role,
        stateId: state.id,
        label: `wait ${td.duration.value}${td.duration.unit}`,
        duration: td.duration,
      });
      break;
    }
    case "guard": {
      const gd = d as IRGuardData;
      if (gd.guardType === "expression" && gd.expr) {
        // Loop guard or alt expression guard
        const trans = transFrom.get(stateId) ?? [];
        const elseTrans = trans.find(t => t.label.kind === "else");
        const defaultTrans = trans.find(t => t.label.kind === "default");
        const exprTrans = trans.filter(t => t.label.kind === "expression");

        if (elseTrans) {
          // This is a loop guard
          elements.push({
            kind: "loop_start",
            role,
            stateId: state.id,
            label: `loop`,
            condition: gd.expr,
          });
          // Walk the body (default transition)
          if (defaultTrans) {
            walkForSequence(defaultTrans.to, stateMap, transFrom, role, elements, visited);
          }
          elements.push({ kind: "loop_end", role, label: "end loop" });
          // Continue with else branch
          walkForSequence(elseTrans.to, stateMap, transFrom, role, elements, visited);
          return;
        }
      }
      if (gd.guardType === "xor") {
        const trans = transFrom.get(stateId) ?? [];
        const msgTrans = trans.filter(t => t.label.kind === "message");
        const exprTrans = trans.filter(t => t.label.kind === "expression");
        const elseTrans = trans.find(t => t.label.kind === "else");

        if (exprTrans.length > 0 || msgTrans.length > 0) {
          elements.push({ kind: "alt_start", role, stateId: state.id, label: "alt" });
          const branches = [...exprTrans, ...msgTrans];
          for (let i = 0; i < branches.length; i++) {
            const b = branches[i];
            const cond = b.label.kind === "expression"
              ? (b.label as { kind: "expression"; expr: string }).expr
              : b.label.kind === "message"
                ? (b.label as { kind: "message"; messageName: string }).messageName
                : "";
            if (i > 0) {
              elements.push({ kind: "alt_branch", role, label: "else", condition: cond });
            } else {
              elements.push({ kind: "alt_branch", role, label: "when", condition: cond });
            }
            walkForSequence(b.to, stateMap, transFrom, role, elements, new Set(visited));
          }
          if (elseTrans) {
            elements.push({ kind: "alt_branch", role, label: "else", condition: "otherwise" });
            walkForSequence(elseTrans.to, stateMap, transFrom, role, elements, new Set(visited));
          }
          elements.push({ kind: "alt_end", role, label: "end alt" });
          return;
        }
      }
      break;
    }
    case "scatter": {
      const sd = d as IRScatterData;
      elements.push({
        kind: "scatter_start",
        role,
        stateId: state.id,
        label: `scatter`,
        collection: sd.collection,
        itemRole: sd.itemRole,
      });
      // Find join first so we can stop branch walking there
      const joinState = findJoinForScatter(state.id, stateMap, transFrom);
      const branchVisited = new Set(visited);
      if (joinState) branchVisited.add(joinState);

      if (sd.branchStartIds.length > 0) {
        walkForSequence(sd.branchStartIds[0], stateMap, transFrom, role, elements, branchVisited);
      }
      elements.push({ kind: "scatter_end", role, label: "end scatter" });

      if (joinState) {
        visited.add(joinState);
        const afterJoin = transFrom.get(joinState) ?? [];
        const next = afterJoin.find(t => t.label.kind === "default");
        if (next) {
          walkForSequence(next.to, stateMap, transFrom, role, elements, visited);
        }
      }
      return;
    }
    case "invoke": {
      const id = d as IRInvokeData;
      elements.push({
        kind: "invoke",
        role,
        stateId: state.id,
        label: `invoke ${id.protocolName}`,
        protocolName: id.protocolName,
      });
      break;
    }
    case "spawn": {
      const sd = d as IRSpawnData;
      elements.push({
        kind: "spawn",
        role,
        stateId: state.id,
        label: `spawn ${sd.protocolName}`,
        protocolName: sd.protocolName,
      });
      break;
    }
    case "fork": {
      const fd = d as IRForkData;
      const forkJoinId = findJoinForFork(state.id, stateMap, transFrom);

      elements.push({ kind: "par_start", role, stateId: state.id, label: "par" });
      for (const branchStart of fd.branchStartIds) {
        const branchV = new Set(visited);
        if (forkJoinId) branchV.add(forkJoinId);
        walkForSequence(branchStart, stateMap, transFrom, role, elements, branchV);
      }
      elements.push({ kind: "par_end", role, label: "end par" });

      if (forkJoinId) {
        visited.add(forkJoinId);
        const afterJoin = transFrom.get(forkJoinId) ?? [];
        const next = afterJoin.find(t => t.label.kind === "default");
        if (next) {
          walkForSequence(next.to, stateMap, transFrom, role, elements, visited);
        }
      }
      return;
    }
    case "initial":
    case "terminal":
    case "join":
    case "error":
      break;
  }

  // Follow default transition
  const trans = transFrom.get(stateId) ?? [];
  const def = trans.find(t => t.label.kind === "default");
  if (def) {
    walkForSequence(def.to, stateMap, transFrom, role, elements, visited);
  }
}

// ── Build State Machine Diagram ────────────────────────────────────

/**
 * Build a state machine diagram for a single role's IRGraph.
 */
export function buildStateMachineDiagram(graph: IRGraph): StateMachineDiagram {
  const nodes: SmNode[] = [];
  const edges: SmEdge[] = [];

  for (const state of graph.states) {
    nodes.push({
      id: state.id,
      kind: state.data.kind as IRStateKind,
      label: stateLabel(state),
      shape: stateShape(state.data.kind as IRStateKind),
      stateId: state.id,
    });
  }

  for (const t of graph.transitions) {
    edges.push({
      from: t.from,
      to: t.to,
      label: transitionLabel(t),
    });
  }

  return { protocolName: graph.protocolName, role: graph.role, nodes, edges };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildTransFromMap(transitions: IRTransition[]): Map<string, IRTransition[]> {
  const m = new Map<string, IRTransition[]>();
  for (const t of transitions) {
    const arr = m.get(t.from) ?? [];
    arr.push(t);
    m.set(t.from, arr);
  }
  return m;
}

function findJoinForScatter(
  scatterId: string,
  stateMap: Map<string, IRState>,
  transFrom: Map<string, IRTransition[]>,
): string | undefined {
  for (const [id, state] of stateMap) {
    if (state.data.kind === "join") {
      // Check if any path from scatter leads to this join
      const trans = transFrom.get(scatterId) ?? [];
      for (const t of trans) {
        if (t.label.kind === "branch") {
          if (reachesJoin(t.to, id, stateMap, transFrom, new Set())) {
            return id;
          }
        }
      }
    }
  }
  return undefined;
}

function findJoinForFork(
  forkId: string,
  stateMap: Map<string, IRState>,
  transFrom: Map<string, IRTransition[]>,
): string | undefined {
  for (const [id, state] of stateMap) {
    if (state.data.kind === "join") {
      const trans = transFrom.get(forkId) ?? [];
      for (const t of trans) {
        if (t.label.kind === "branch") {
          if (reachesJoin(t.to, id, stateMap, transFrom, new Set())) {
            return id;
          }
        }
      }
    }
  }
  return undefined;
}

function reachesJoin(
  from: string,
  joinId: string,
  stateMap: Map<string, IRState>,
  transFrom: Map<string, IRTransition[]>,
  visited: Set<string>,
): boolean {
  if (from === joinId) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  for (const t of transFrom.get(from) ?? []) {
    if (reachesJoin(t.to, joinId, stateMap, transFrom, visited)) return true;
  }
  return false;
}

function summarizeZone(body: string): string {
  const trimmed = body.trim();
  const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);

  const names: string[] = [];
  for (const line of lines) {
    const assign = line.match(/^(\$(?:ctx|flow|self)\.\w+)\s*=/);
    if (assign) { names.push(assign[1]); continue; }
    const awaitCall = line.match(/await\s+\$agent\.(\w+)/);
    if (awaitCall) { names.push(`$agent.${awaitCall[1]}()`); continue; }
    const agentCall = line.match(/\$agent\.(\w+)\s*\(/);
    if (agentCall) { names.push(`$agent.${agentCall[1]}()`); continue; }
    const reagentCall = line.match(/reagent\.(\w+)\s*\(/);
    if (reagentCall) { names.push(`reagent.${reagentCall[1]}()`); continue; }
    const fnCall = line.match(/^(\w+)\s*\(/);
    if (fnCall && !line.startsWith("if") && !line.startsWith("for") && !line.startsWith("while")) {
      names.push(`${fnCall[1]}()`); continue;
    }
  }

  if (names.length === 0) {
    const firstLine = lines[0] ?? "";
    if (firstLine.length > 30) return firstLine.slice(0, 27) + "...";
    return firstLine || "action";
  }

  const summary = names.slice(0, 3).join(", ");
  if (summary.length > 40) return summary.slice(0, 37) + "...";
  return summary;
}

function stateLabel(state: IRState): string {
  const d = state.data;
  switch (d.kind) {
    case "initial": return "●";
    case "terminal": return "◉";
    case "send": return `→ ${(d as IRSendData).messageName}`;
    case "receive": return `← ${(d as IRReceiveData).messageName}`;
    case "action": return summarizeZone((d as IRActionData).body);
    case "guard": {
      const gd = d as IRGuardData;
      if (gd.guardType === "xor") return "alt";
      return gd.expr ? `[${summarizeZone(gd.expr)}]` : "guard";
    }
    case "timer": {
      const td = d as IRTimerData;
      return `⏱ ${td.duration.value}${td.duration.unit}`;
    }
    case "scatter": return `scatter(${(d as IRScatterData).itemRole})`;
    case "invoke": return `invoke ${(d as IRInvokeData).protocolName}`;
    case "spawn": return `spawn ${(d as IRSpawnData).protocolName}`;
    case "fork": return "fork";
    case "join": return "join";
    case "error": return "error";
    default: return state.id;
  }
}

function stateShape(kind: IRStateKind): SmNodeShape {
  switch (kind) {
    case "initial":
    case "terminal":
      return "circle";
    case "guard":
      return "diamond";
    case "scatter":
      return "hexagon";
    case "invoke":
      return "double-rect";
    case "timer":
      return "pill";
    default:
      return "rect";
  }
}

function transitionLabel(t: IRTransition): string | undefined {
  switch (t.label.kind) {
    case "default": return undefined;
    case "message": return (t.label as { kind: "message"; messageName: string }).messageName;
    case "expression": return (t.label as { kind: "expression"; expr: string }).expr;
    case "timeout": {
      const d = (t.label as { kind: "timeout"; duration: { value: number; unit: string } }).duration;
      return `${d.value}${d.unit}`;
    }
    case "else": return "else";
    case "error": return "error";
    case "branch": return `branch ${(t.label as { kind: "branch"; branchIndex: number }).branchIndex}`;
  }
}
