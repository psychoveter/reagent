/**
 * diagram.ts — IR/AST to diagram data model.
 *
 * Converts compiled IRGraphs (per-role state machines) or parsed ASTs
 * into a unified diagram model suitable for sequence diagram and
 * state machine rendering.
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
  IRAsyncInvokeData,
  IRSpawnData,
  TriggerIR,
} from "./ir.js";

import type {
  ProtocolDef,
  ProtocolItem,
  ParticipantDecl,
  TriggerDecl,
} from "./ast.js";

// ── Sequence Diagram Model ─────────────────────────────────────────

export type Participant = {
  name: string;
  lang?: string;
  isInitiator: boolean;
  binding?: "static" | "dynamic";
  cardinality?: "single" | "many";
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
  | "async_invoke"
  | "spawn"
  | "par_start"
  | "par_end"
  | "trigger";

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
  /** Source line from AST loc (1-based). Used for click-to-source when stateId is absent. */
  sourceLine?: number;
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

  // Build a lookup of participant metadata from any graph that has the participants array
  const participantMeta = new Map<string, { binding?: "static" | "dynamic"; cardinality?: "single" | "many"; initiator: boolean }>();
  for (const [, graph] of graphs) {
    if (graph.protocolName !== protocolName || !graph.participants) continue;
    for (const p of graph.participants) {
      if (!participantMeta.has(p.name)) {
        participantMeta.set(p.name, { binding: p.binding, cardinality: p.cardinality, initiator: p.initiator });
      }
    }
  }

  for (const [key, graph] of graphs) {
    if (graph.protocolName !== protocolName) continue;
    version = version ?? graph.version;
    if (!roleSet.has(graph.role)) {
      roleSet.add(graph.role);
      const meta = participantMeta.get(graph.role);
      const isInit = meta?.initiator === true;
      participants.push({
        name: graph.role,
        lang: graph.lang,
        isInitiator: isInit,
        binding: meta?.binding,
        cardinality: meta?.cardinality,
      });
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

  // Emit trigger entry-point annotations
  const triggers = initiatorGraph.triggers;
  if (triggers && triggers.length > 0) {
    for (const t of triggers) {
      elements.push({
        kind: "trigger",
        role: initiatorRole,
        label: triggerLabel(t),
      });
    }
  }

  const stateMap = new Map<string, IRState>();
  for (const s of initiatorGraph.states) stateMap.set(s.id, s);
  const transFrom = buildTransFromMap(initiatorGraph.transitions);

  walkForSequence(initiatorGraph.initialStateId, stateMap, transFrom, initiatorRole, elements, new Set());

  return { protocolName, version, participants, elements };
}

// ── Build Sequence Diagram from AST ───────────────────────────────

/**
 * Build a sequence diagram by walking the protocol AST directly.
 *
 * Unlike `buildSequenceDiagram` (which walks the initiator's IR graph and
 * therefore only sees messages involving the initiator), this function walks
 * the protocol body — the global choreography — so it emits elements for
 * **all** inter-role messages, actions, and control structures.
 *
 * Preferred when the parsed AST is available (always the case in the VSCode
 * extension). Falls back to `buildSequenceDiagram` when only IR is available
 * (e.g. decompiling deployed IR from a running cluster).
 */
export function buildSequenceDiagramFromAST(
  protocol: ProtocolDef,
  version?: string,
): SequenceDiagram {
  const participants: Participant[] = protocol.participants.map(p => ({
    name: p.name,
    lang: p.lang === "*" ? undefined : p.lang,
    isInitiator: p.initiator === true,
    binding: p.binding,
    cardinality: p.cardinality,
  }));

  const initiator = participants.find(p => p.isInitiator)?.name
    ?? participants[0]?.name
    ?? "";

  const elements: SeqElement[] = [];

  // Emit trigger annotations
  for (const t of protocol.triggers ?? []) {
    elements.push({
      kind: "trigger",
      role: initiator,
      label: astTriggerLabel(t),
    });
  }

  walkASTBody(protocol.body, elements);

  return { protocolName: protocol.name, version, participants, elements };
}

function walkASTBody(body: ProtocolItem[], elements: SeqElement[]): void {
  for (const item of body) {
    switch (item.kind) {
      case "MessageStmt": {
        const isAsync = item.props?.hooks.some(h =>
          /\bawait\b/.test(h.body)
        ) ?? false;
        elements.push({
          kind: "message",
          role: item.from,
          from: item.from,
          to: item.to,
          label: item.messageName,
          async: isAsync || undefined,
          sourceLine: item.loc.start.line,
        });
        break;
      }
      case "AgentZone": {
        const isAsync = /\bawait\b/.test(item.body);
        elements.push({
          kind: "action",
          role: item.agent,
          label: summarizeZone(item.body),
          async: isAsync || undefined,
          sourceLine: item.loc.start.line,
        });
        break;
      }
      case "LoopStmt": {
        elements.push({
          kind: "loop_start",
          role: "",
          label: "loop",
          condition: item.guard,
          sourceLine: item.loc.start.line,
        });
        walkASTBody(item.body, elements);
        elements.push({ kind: "loop_end", role: "", label: "end loop" });
        break;
      }
      case "AltStmt": {
        elements.push({ kind: "alt_start", role: "", label: "alt", sourceLine: item.loc.start.line });
        for (let i = 0; i < item.branches.length; i++) {
          const branch = item.branches[i];
          const cond = altGuardLabel(branch.guard);
          if (i === 0) {
            elements.push({ kind: "alt_branch", role: "", label: "when", condition: cond, sourceLine: branch.loc.start.line });
          } else {
            elements.push({ kind: "alt_branch", role: "", label: "else", condition: cond, sourceLine: branch.loc.start.line });
          }

          if (branch.guard.kind === "AltMessageGuard") {
            elements.push({
              kind: "message",
              role: branch.guard.from,
              from: branch.guard.from,
              to: branch.guard.to,
              label: branch.guard.messageName,
              sourceLine: branch.guard.loc.start.line,
            });
          }

          walkASTBody(branch.body, elements);
        }
        elements.push({ kind: "alt_end", role: "", label: "end alt" });
        break;
      }
      case "ScatterStmt": {
        elements.push({
          kind: "scatter_start",
          role: "",
          label: "scatter",
          collection: item.collection,
          itemRole: item.itemRole,
          sourceLine: item.loc.start.line,
        });
        walkASTBody(item.body, elements);
        elements.push({ kind: "scatter_end", role: "", label: "end scatter" });
        break;
      }
      case "ParStmt": {
        elements.push({ kind: "par_start", role: "", label: "par", sourceLine: item.loc.start.line });
        for (const branch of item.branches) {
          walkASTBody(branch.body, elements);
        }
        elements.push({ kind: "par_end", role: "", label: "end par" });
        break;
      }
      case "InvokeStmt": {
        elements.push({
          kind: item.async ? "async_invoke" : "invoke",
          role: item.callerRole,
          label: `${item.async ? "async " : ""}invoke ${item.protocolName}`,
          protocolName: item.protocolName,
          sourceLine: item.loc.start.line,
        });
        break;
      }
      case "SpawnStmt": {
        elements.push({
          kind: "spawn",
          role: item.callerRole,
          label: `spawn ${item.roleName}`,
          protocolName: item.roleName,
          sourceLine: item.loc.start.line,
        });
        break;
      }
      case "WaitStmt": {
        elements.push({
          kind: "timer",
          role: "",
          label: `wait ${item.duration.value}${item.duration.unit}`,
          duration: item.duration,
          sourceLine: item.loc.start.line,
        });
        break;
      }
      case "TryStmt": {
        elements.push({ kind: "alt_start", role: "", label: "try", sourceLine: item.loc.start.line });
        elements.push({ kind: "alt_branch", role: "", label: "try", condition: "success" });
        walkASTBody(item.tryBody, elements);
        elements.push({ kind: "alt_branch", role: "", label: "catch", condition: item.catchLabel });
        walkASTBody(item.catchBody, elements);
        elements.push({ kind: "alt_end", role: "", label: "end try" });
        break;
      }
    }
  }
}

function altGuardLabel(guard: import("./ast.js").AltGuard): string {
  switch (guard.kind) {
    case "AltExprGuard": return guard.expr;
    case "AltMessageGuard": return guard.messageName;
    case "AltTimeoutGuard": return `${guard.duration.value}${guard.duration.unit}`;
    case "AltElseGuard": return "otherwise";
  }
}

function astTriggerLabel(t: TriggerDecl): string {
  switch (t.triggerKind) {
    case "invoke": return `trigger on invoke${t.withType ? ` with ${t.withType}` : ""}`;
    case "cron":   return `trigger on cron "${t.cronExpr ?? "..."}"`;
    case "event":  return `trigger on event "${t.topic ?? ""}"${t.withType ? ` with ${t.withType}` : ""}`;
  }
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
    case "async_invoke": {
      const aid = d as IRAsyncInvokeData;
      elements.push({
        kind: "async_invoke",
        role,
        stateId: state.id,
        label: `async invoke ${aid.protocolName}`,
        protocolName: aid.protocolName,
      });
      break;
    }
    case "spawn": {
      const sd = d as IRSpawnData;
      elements.push({
        kind: "async_invoke",
        role,
        stateId: state.id,
        label: `spawn ${sd.roleName}`,
        protocolName: sd.roleName,
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

  const calls: string[] = [];
  const assigns: string[] = [];

  for (const line of lines) {
    const awaitCall = line.match(/await\s+\$agent\.(\w+)/);
    if (awaitCall) { calls.push(awaitCall[1]); continue; }
    const agentCall = line.match(/\$agent\.(\w+)\s*\(/);
    if (agentCall) { calls.push(agentCall[1]); continue; }
    const reagentCall = line.match(/reagent\.(\w+)\s*\(/);
    if (reagentCall) { calls.push(reagentCall[1]); continue; }

    const assign = line.match(/^\$(?:ctx|self)\.(\w+)\s*=/);
    if (assign) { assigns.push(assign[1]); continue; }

    const fnCall = line.match(/^(\w+)\s*\(/);
    if (fnCall && !line.startsWith("if") && !line.startsWith("for") && !line.startsWith("while")) {
      calls.push(fnCall[1]); continue;
    }
  }

  if (calls.length > 0) {
    const label = calls.slice(0, 2).join(", ");
    const suffix = assigns.length > 0 ? ` → ${assigns[0]}` : "";
    const full = label + suffix;
    return full.length > 28 ? full.slice(0, 25) + "…" : full;
  }

  if (assigns.length > 0) {
    const label = assigns.slice(0, 2).join(", ");
    return label.length > 28 ? label.slice(0, 25) + "…" : label;
  }

  const firstLine = lines[0] ?? "";
  if (firstLine.length > 28) return firstLine.slice(0, 25) + "…";
  return firstLine || "action";
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
    case "async_invoke": return `async invoke ${(d as IRAsyncInvokeData).protocolName}`;
    case "spawn": return `spawn ${(d as IRSpawnData).roleName}`;
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

function triggerLabel(t: TriggerIR): string {
  switch (t.kind) {
    case "invoke": return `trigger on invoke with ${t.withType}`;
    case "cron":   return `trigger on cron "${t.cron}"`;
    case "event":  return `trigger on event "${t.topic}" with ${t.withType}`;
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
