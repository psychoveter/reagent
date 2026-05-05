/**
 * Reagent IR Fingerprinting — M8a
 *
 * Computes deterministic SHA-256 fingerprints for protocols and roles.
 * All functions are pure (no I/O, no side effects).
 */
import { createHash } from "node:crypto";
// ── Helpers ─────────────────────────────────────────────────────────
function sha256(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
}
function normalizeWhitespace(s) {
    return s.trim().replace(/\s+/g, " ");
}
/**
 * BFS traversal of an IRGraph starting from initialStateId.
 * Returns states in visit order and a mapping from state ID to BFS index.
 */
function bfsTraversal(graph) {
    const stateById = new Map();
    for (const s of graph.states)
        stateById.set(s.id, s);
    const adj = new Map();
    for (const t of graph.transitions) {
        let list = adj.get(t.from);
        if (!list) {
            list = [];
            adj.set(t.from, list);
        }
        list.push(t);
    }
    const visited = new Set();
    const ordered = [];
    const queue = [graph.initialStateId];
    visited.add(graph.initialStateId);
    while (queue.length > 0) {
        const id = queue.shift();
        const state = stateById.get(id);
        if (state)
            ordered.push(state);
        const transitions = adj.get(id) ?? [];
        transitions.sort((a, b) => a.to.localeCompare(b.to));
        for (const t of transitions) {
            if (!visited.has(t.to)) {
                visited.add(t.to);
                queue.push(t.to);
            }
        }
    }
    const indexMap = new Map();
    for (let i = 0; i < ordered.length; i++)
        indexMap.set(ordered[i].id, i);
    return { ordered, indexMap };
}
// ── Structure Hash ──────────────────────────────────────────────────
function canonicalizeState(state) {
    const d = state.data;
    const parts = [d.kind];
    switch (d.kind) {
        case "send":
            parts.push(d.to, d.arrow, d.messageName);
            break;
        case "receive":
            parts.push(d.from, d.arrow, d.messageName);
            if (d.pattern)
                parts.push(JSON.stringify(d.pattern, Object.keys(d.pattern).sort()));
            break;
        case "guard":
            parts.push(d.guardType);
            if (d.expr)
                parts.push(d.expr);
            if (d.decisionRole)
                parts.push(`at:${d.decisionRole}`);
            break;
        case "fork":
            parts.push(String(d.branchStartIds.length));
            break;
        case "join":
            parts.push(String(d.branchCount));
            break;
        case "timer":
            parts.push(String(d.duration.value), d.duration.unit);
            break;
        case "terminal":
            parts.push(d.status);
            break;
        case "error":
            parts.push(d.label);
            break;
        case "invoke":
            parts.push(d.protocolName, d.input);
            break;
        case "async_invoke":
            parts.push(d.protocolName, d.input);
            break;
        case "spawn":
            parts.push(d.roleName, d.config);
            if (d.bindAs)
                parts.push(d.bindAs);
            if (d.persistent)
                parts.push("persistent");
            break;
        case "scatter":
            parts.push(d.collection, d.itemRole, String(d.branchStartIds.length));
            break;
    }
    return parts.join("|");
}
function canonicalizeTransitionLabel(label) {
    switch (label.kind) {
        case "default": return "default";
        case "message": {
            let s = `message|${label.messageName}`;
            if (label.pattern)
                s += "|" + JSON.stringify(label.pattern, Object.keys(label.pattern).sort());
            return s;
        }
        case "timeout": return `timeout|${label.duration.value}|${label.duration.unit}`;
        case "expression": return `expression|${label.expr}`;
        case "else": return "else";
        case "error": return "error";
        case "branch": return `branch|${label.branchIndex}`;
    }
}
/**
 * Computes the structure hash — captures choreography topology.
 * Roles sorted alphabetically, state IDs replaced with BFS indices.
 */
function canonicalizeTrigger(t) {
    let base;
    switch (t.kind) {
        case "invoke":
            base = `trigger:invoke:${t.withType}`;
            break;
        case "cron":
            base = `trigger:cron:${t.cron}:CronTrigger`;
            break;
        case "event":
            base = `trigger:event:${t.topic}:${t.withType}`;
            break;
    }
    if (t.resolveMap) {
        const keys = Object.keys(t.resolveMap).sort();
        for (const k of keys) {
            const steps = t.resolveMap[k].map(s => s.step).join("|");
            base += `:resolve:${k}=${steps}`;
        }
    }
    return base;
}
export function computeStructureHash(graphs) {
    const roles = [...graphs.keys()].sort();
    const parts = [];
    const firstGraph = graphs.values().next().value;
    if (firstGraph?.participants) {
        for (const p of firstGraph.participants) {
            parts.push(`participant:${p.name}:${p.binding}:${p.cardinality}:${p.initiator}`);
        }
    }
    if (firstGraph?.supervisionStrategy) {
        parts.push(`supervision:${firstGraph.supervisionStrategy}`);
    }
    if (firstGraph?.triggers) {
        for (const t of firstGraph.triggers) {
            parts.push(canonicalizeTrigger(t));
        }
    }
    for (const role of roles) {
        const graph = graphs.get(role);
        const { ordered, indexMap } = bfsTraversal(graph);
        parts.push(`role:${role}`);
        for (const state of ordered) {
            const idx = indexMap.get(state.id);
            parts.push(`s:${idx}:${canonicalizeState(state)}`);
        }
        const sortedTransitions = [...graph.transitions]
            .filter(t => indexMap.has(t.from) && indexMap.has(t.to))
            .sort((a, b) => {
            const ai = indexMap.get(a.from) * 10000 + indexMap.get(a.to);
            const bi = indexMap.get(b.from) * 10000 + indexMap.get(b.to);
            return ai - bi;
        });
        for (const t of sortedTransitions) {
            parts.push(`t:${indexMap.get(t.from)}:${indexMap.get(t.to)}:${canonicalizeTransitionLabel(t.label)}`);
        }
    }
    return sha256(parts.join("\n"));
}
// ── Schema Hash ─────────────────────────────────────────────────────
function canonicalizeField(f) {
    return `${f.name}:${JSON.stringify(f.type)}:${f.optional}`;
}
/**
 * Computes the schema hash — captures message type definitions.
 * Only schemas whose names appear in send/receive states are included.
 */
export function computeSchemaHash(schemas, usedNames) {
    const relevant = schemas
        .filter(s => usedNames.has(s.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (relevant.length === 0)
        return sha256("");
    const parts = [];
    for (const s of relevant) {
        const fields = [...s.fields]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(canonicalizeField)
            .join(",");
        parts.push(`${s.name}:{${fields}}`);
    }
    return sha256(parts.join("\n"));
}
// ── Implementation Hash ─────────────────────────────────────────────
/**
 * Computes the implementation hash — captures zone bodies and guard expressions.
 * Whitespace-normalized, ordered by BFS traversal, roles sorted alphabetically.
 */
export function computeImplHash(graphs) {
    const roles = [...graphs.keys()].sort();
    const parts = [];
    for (const role of roles) {
        const graph = graphs.get(role);
        const { ordered } = bfsTraversal(graph);
        for (const state of ordered) {
            const d = state.data;
            switch (d.kind) {
                case "action":
                    parts.push(normalizeWhitespace(d.body));
                    break;
                case "send":
                    if (d.preSendZone)
                        parts.push(normalizeWhitespace(d.preSendZone));
                    break;
                case "receive":
                    if (d.postReceiveZone)
                        parts.push(normalizeWhitespace(d.postReceiveZone));
                    break;
                case "guard":
                    if (d.expr)
                        parts.push(normalizeWhitespace(d.expr));
                    break;
            }
        }
    }
    return sha256(parts.join("\n"));
}
// ── Protocol Fingerprint (composite) ────────────────────────────────
/**
 * Extracts all message names used in send/receive states across all role graphs.
 */
export function extractUsedMessageNames(graphs) {
    const names = new Set();
    for (const graph of graphs.values()) {
        for (const state of graph.states) {
            if (state.data.kind === "send" || state.data.kind === "receive") {
                names.add(state.data.messageName);
            }
        }
    }
    return names;
}
/**
 * Extracts protocol dependencies from invoke/spawn states.
 * Version and structureHash are left empty — filled by the caller from the lock file.
 */
export function extractDependencies(graphs) {
    const seen = new Set();
    const deps = [];
    for (const graph of graphs.values()) {
        for (const state of graph.states) {
            if (state.data.kind === "invoke" || state.data.kind === "async_invoke") {
                const name = state.data.protocolName;
                if (!seen.has(name)) {
                    seen.add(name);
                    deps.push({ protocolName: name, structureHash: "", version: "" });
                }
            }
        }
    }
    return deps.sort((a, b) => a.protocolName.localeCompare(b.protocolName));
}
/**
 * Computes the full protocol fingerprint (three hashes).
 */
export function computeProtocolFingerprint(graphs, schemas, usedMessageNames) {
    return {
        structureHash: computeStructureHash(graphs),
        schemaHash: computeSchemaHash(schemas, usedMessageNames),
        implHash: computeImplHash(graphs),
    };
}
// ── Role Fingerprint ────────────────────────────────────────────────
/**
 * Computes the role fingerprint (two hashes).
 * `protocolVersions` maps protocol names to their resolved versions —
 * ensures role version bumps when a referenced protocol changes.
 */
export function computeRoleFingerprint(roleIR, protocolVersions) {
    const playsEntries = [...roleIR.plays]
        .sort((a, b) => a.protocolName.localeCompare(b.protocolName) || a.roleName.localeCompare(b.roleName))
        .map(p => {
        const ver = protocolVersions?.get(p.protocolName) ?? p.protocolVersion ?? "";
        return `${p.protocolName}@${ver}:${p.roleName}`;
    })
        .join("\n");
    const behaviorParts = [];
    if (roleIR.lang)
        behaviorParts.push(`lang:${roleIR.lang}`);
    if (roleIR.initAction)
        behaviorParts.push(`init:${normalizeWhitespace(roleIR.initAction.body)}`);
    const sortedHandlers = [...roleIR.lifecycleHandlers]
        .sort((a, b) => a.event.localeCompare(b.event) ||
        (a.protocolFilter ?? "").localeCompare(b.protocolFilter ?? ""));
    for (const h of sortedHandlers) {
        behaviorParts.push(`handler:${h.event}:${h.protocolFilter ?? "*"}:${normalizeWhitespace(h.action.body)}`);
    }
    return {
        playsHash: sha256(playsEntries),
        behaviorHash: sha256(behaviorParts.join("\n")),
    };
}
