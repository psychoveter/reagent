/**
 * diagram.ts — IR to diagram data model.
 *
 * Converts compiled IRGraphs (per-role state machines) into a unified
 * diagram model suitable for sequence diagram and state machine rendering.
 * Shared between VSCode extension and CLI.
 */
// ── Build Sequence Diagram ─────────────────────────────────────────
/**
 * Build a sequence diagram from multiple per-role IRGraphs of the same protocol.
 * Walks the initiator's graph as the primary timeline, cross-referencing
 * other roles for receive-side information.
 */
export function buildSequenceDiagram(graphs, protocolName) {
    const participants = [];
    const roleSet = new Set();
    let initiatorRole;
    let initiatorGraph;
    let version;
    for (const [key, graph] of graphs) {
        if (graph.protocolName !== protocolName)
            continue;
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
        if (!first)
            return { protocolName, participants: [], elements: [] };
        initiatorGraph = first;
        initiatorRole = first.role;
        if (!participants.some(p => p.name === first.role)) {
            participants.push({ name: first.role, isInitiator: true });
        }
    }
    const elements = [];
    const stateMap = new Map();
    for (const s of initiatorGraph.states)
        stateMap.set(s.id, s);
    const transFrom = buildTransFromMap(initiatorGraph.transitions);
    walkForSequence(initiatorGraph.initialStateId, stateMap, transFrom, initiatorRole, elements, new Set());
    return { protocolName, version, participants, elements };
}
function walkForSequence(stateId, stateMap, transFrom, role, elements, visited) {
    if (visited.has(stateId))
        return;
    visited.add(stateId);
    const state = stateMap.get(stateId);
    if (!state)
        return;
    const d = state.data;
    switch (d.kind) {
        case "send": {
            const sd = d;
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
            const rd = d;
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
            const ad = d;
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
            const td = d;
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
            const gd = d;
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
                            ? b.label.expr
                            : b.label.kind === "message"
                                ? b.label.messageName
                                : "";
                        if (i > 0) {
                            elements.push({ kind: "alt_branch", role, label: "else", condition: cond });
                        }
                        else {
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
            const sd = d;
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
            if (joinState)
                branchVisited.add(joinState);
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
            const id = d;
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
            const sd = d;
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
            const fd = d;
            const forkJoinId = findJoinForFork(state.id, stateMap, transFrom);
            elements.push({ kind: "par_start", role, stateId: state.id, label: "par" });
            for (const branchStart of fd.branchStartIds) {
                const branchV = new Set(visited);
                if (forkJoinId)
                    branchV.add(forkJoinId);
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
export function buildStateMachineDiagram(graph) {
    const nodes = [];
    const edges = [];
    for (const state of graph.states) {
        nodes.push({
            id: state.id,
            kind: state.data.kind,
            label: stateLabel(state),
            shape: stateShape(state.data.kind),
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
function buildTransFromMap(transitions) {
    const m = new Map();
    for (const t of transitions) {
        const arr = m.get(t.from) ?? [];
        arr.push(t);
        m.set(t.from, arr);
    }
    return m;
}
function findJoinForScatter(scatterId, stateMap, transFrom) {
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
function findJoinForFork(forkId, stateMap, transFrom) {
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
function reachesJoin(from, joinId, stateMap, transFrom, visited) {
    if (from === joinId)
        return true;
    if (visited.has(from))
        return false;
    visited.add(from);
    for (const t of transFrom.get(from) ?? []) {
        if (reachesJoin(t.to, joinId, stateMap, transFrom, visited))
            return true;
    }
    return false;
}
function summarizeZone(body) {
    const trimmed = body.trim();
    const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
    const names = [];
    for (const line of lines) {
        const assign = line.match(/^(\$(?:ctx|flow|self)\.\w+)\s*=/);
        if (assign) {
            names.push(assign[1]);
            continue;
        }
        const awaitCall = line.match(/await\s+\$agent\.(\w+)/);
        if (awaitCall) {
            names.push(`$agent.${awaitCall[1]}()`);
            continue;
        }
        const agentCall = line.match(/\$agent\.(\w+)\s*\(/);
        if (agentCall) {
            names.push(`$agent.${agentCall[1]}()`);
            continue;
        }
        const reagentCall = line.match(/reagent\.(\w+)\s*\(/);
        if (reagentCall) {
            names.push(`reagent.${reagentCall[1]}()`);
            continue;
        }
        const fnCall = line.match(/^(\w+)\s*\(/);
        if (fnCall && !line.startsWith("if") && !line.startsWith("for") && !line.startsWith("while")) {
            names.push(`${fnCall[1]}()`);
            continue;
        }
    }
    if (names.length === 0) {
        const firstLine = lines[0] ?? "";
        if (firstLine.length > 30)
            return firstLine.slice(0, 27) + "...";
        return firstLine || "action";
    }
    const summary = names.slice(0, 3).join(", ");
    if (summary.length > 40)
        return summary.slice(0, 37) + "...";
    return summary;
}
function stateLabel(state) {
    const d = state.data;
    switch (d.kind) {
        case "initial": return "●";
        case "terminal": return "◉";
        case "send": return `→ ${d.messageName}`;
        case "receive": return `← ${d.messageName}`;
        case "action": return summarizeZone(d.body);
        case "guard": {
            const gd = d;
            if (gd.guardType === "xor")
                return "alt";
            return gd.expr ? `[${summarizeZone(gd.expr)}]` : "guard";
        }
        case "timer": {
            const td = d;
            return `⏱ ${td.duration.value}${td.duration.unit}`;
        }
        case "scatter": return `scatter(${d.itemRole})`;
        case "invoke": return `invoke ${d.protocolName}`;
        case "spawn": return `spawn ${d.protocolName}`;
        case "fork": return "fork";
        case "join": return "join";
        case "error": return "error";
        default: return state.id;
    }
}
function stateShape(kind) {
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
function transitionLabel(t) {
    switch (t.label.kind) {
        case "default": return undefined;
        case "message": return t.label.messageName;
        case "expression": return t.label.expr;
        case "timeout": {
            const d = t.label.duration;
            return `${d.value}${d.unit}`;
        }
        case "else": return "else";
        case "error": return "error";
        case "branch": return `branch ${t.label.branchIndex}`;
    }
}
