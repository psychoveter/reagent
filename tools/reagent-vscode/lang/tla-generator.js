/**
 * TLA+ specification generator from Reagent IR.
 *
 * Reads compiled per-role IRGraphs and produces a TLA+ module
 * that models the protocol as concurrent PlusCal processes
 * communicating via message channels.
 *
 * Properties checked:
 * - Deadlock freedom (no stuck states)
 * - Protocol completion (all roles reach terminal)
 */
function sanitizeId(id) {
    return id.replace(/[^a-zA-Z0-9_]/g, "_");
}
function escapeString(s) {
    return s.replace(/"/g, '\\"');
}
function buildTransitionMap(graph) {
    const map = new Map();
    for (const t of graph.transitions) {
        const list = map.get(t.from) ?? [];
        list.push(t);
        map.set(t.from, list);
    }
    return map;
}
export function generateTLAPlus(protocolName, graphs) {
    const lines = [];
    const roleNames = [...graphs.keys()];
    const roleSet = roleNames.map((r) => `"${r}"`).join(", ");
    lines.push(`---- MODULE ${sanitizeId(protocolName)} ----`);
    lines.push(`EXTENDS Naturals, Sequences, FiniteSets, TLC`);
    lines.push(``);
    lines.push(`CONSTANTS Roles`);
    lines.push(``);
    lines.push(`VARIABLES`);
    lines.push(`  pc,          \\* per-role program counter (state ID)`);
    lines.push(`  status,      \\* per-role status: "running" | "completed" | "failed"`);
    lines.push(`  channels,    \\* channels[<<from, to>>] = sequence of messages`);
    lines.push(`  timer_fired  \\* per-role timer flag`);
    lines.push(``);
    lines.push(`vars == <<pc, status, channels, timer_fired>>`);
    lines.push(``);
    // Channel helper definitions
    const channelPairs = new Set();
    for (const [role, graph] of graphs) {
        for (const state of graph.states) {
            if (state.data.kind === "send") {
                channelPairs.add(`<<"${role}", "${state.data.to}">>`);
            }
        }
    }
    lines.push(`ChannelPairs == {${[...channelPairs].join(", ")}}`);
    lines.push(``);
    // Init
    lines.push(`Init ==`);
    lines.push(`  /\\ pc = [r \\in {${roleSet}} |-> CASE`);
    for (let i = 0; i < roleNames.length; i++) {
        const role = roleNames[i];
        const graph = graphs.get(role);
        const sep = i < roleNames.length - 1 ? "" : "]";
        lines.push(`       r = "${role}" -> "${graph.initialStateId}"${sep}`);
    }
    lines.push(`  /\\ status = [r \\in {${roleSet}} |-> "running"]`);
    lines.push(`  /\\ channels = [p \\in ChannelPairs |-> <<>>]`);
    lines.push(`  /\\ timer_fired = [r \\in {${roleSet}} |-> FALSE]`);
    lines.push(``);
    // Per-role next-state actions
    for (const [role, graph] of graphs) {
        const transMap = buildTransitionMap(graph);
        const states = graph.states;
        const roleId = sanitizeId(role);
        lines.push(`\\* ── Role: ${role} ──`);
        lines.push(``);
        for (const state of states) {
            const stateId = sanitizeId(state.id);
            const transitions = transMap.get(state.id) ?? [];
            if (state.data.kind === "terminal") {
                lines.push(`${roleId}_${stateId} ==`);
                lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                lines.push(`  /\\ status' = [status EXCEPT !["${role}"] = "${state.data.status ?? "completed"}"]`);
                lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "DONE"]`);
                lines.push(`  /\\ UNCHANGED <<channels, timer_fired>>`);
                lines.push(``);
                continue;
            }
            if (transitions.length === 0)
                continue;
            if (state.data.kind === "initial" || state.data.kind === "action") {
                // Simple advance through default transitions
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "send") {
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    const target = state.data.to;
                    const msgName = state.data.messageName;
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ channels' = [channels EXCEPT ![<<"${role}", "${target}">>] = Append(@, "${escapeString(msgName)}")]`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "receive") {
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    const from = state.data.from;
                    const msgName = state.data.messageName;
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ Len(channels[<<"${from}", "${role}">>]) > 0`);
                    lines.push(`  /\\ Head(channels[<<"${from}", "${role}">>]) = "${escapeString(msgName)}"`);
                    lines.push(`  /\\ channels' = [channels EXCEPT ![<<"${from}", "${role}">>] = Tail(@)]`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "guard") {
                const guardType = state.data.guardType;
                if (guardType === "xor") {
                    // XOR: nondeterministic choice between branches
                    const messageTrans = transitions.filter((t) => t.label.kind === "message");
                    const timeoutTrans = transitions.filter((t) => t.label.kind === "timeout");
                    const exprTrans = transitions.filter((t) => t.label.kind === "expression");
                    const elseTrans = transitions.filter((t) => t.label.kind === "else");
                    const allBranches = [...messageTrans, ...timeoutTrans, ...exprTrans, ...elseTrans];
                    if (allBranches.length > 0) {
                        lines.push(`${roleId}_${stateId} ==`);
                        lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                        const disjuncts = [];
                        for (const t of allBranches) {
                            disjuncts.push(`pc' = [pc EXCEPT !["${role}"] = "${t.to}"]`);
                        }
                        lines.push(`  /\\ (${disjuncts.join(" \\/ ")})`);
                        lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                        lines.push(``);
                    }
                }
                else if (guardType === "expression") {
                    // Expression guard / merge point: take all available transitions
                    const allTrans = transitions;
                    if (allTrans.length === 1) {
                        lines.push(`${roleId}_${stateId} ==`);
                        lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                        lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${allTrans[0].to}"]`);
                        lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                        lines.push(``);
                    }
                    else if (allTrans.length > 1) {
                        // Loop guard: nondeterministic (continue or exit)
                        lines.push(`${roleId}_${stateId} ==`);
                        lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                        const disjuncts = allTrans.map((t) => `pc' = [pc EXCEPT !["${role}"] = "${t.to}"]`);
                        lines.push(`  /\\ (${disjuncts.join(" \\/ ")})`);
                        lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                        lines.push(``);
                    }
                }
                continue;
            }
            if (state.data.kind === "timer") {
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ timer_fired' = [timer_fired EXCEPT !["${role}"] = TRUE]`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "fork") {
                // Parallel: model as nondeterministic choice of first branch
                // (full interleaving is complex; we model as sequential branches)
                const branchTrans = transitions.filter((t) => t.label.kind === "branch");
                if (branchTrans.length > 0) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${branchTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "join") {
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "invoke" || state.data.kind === "spawn") {
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "scatter") {
                const branchTrans = transitions.filter((t) => t.label.kind === "branch");
                if (branchTrans.length > 0) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${branchTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
            if (state.data.kind === "error") {
                const defaultTrans = transitions.filter((t) => t.label.kind === "default");
                if (defaultTrans.length === 1) {
                    lines.push(`${roleId}_${stateId} ==`);
                    lines.push(`  /\\ pc["${role}"] = "${state.id}"`);
                    lines.push(`  /\\ pc' = [pc EXCEPT !["${role}"] = "${defaultTrans[0].to}"]`);
                    lines.push(`  /\\ UNCHANGED <<status, channels, timer_fired>>`);
                    lines.push(``);
                }
                continue;
            }
        }
    }
    // Collect all action names
    const actionNames = [];
    for (const [role, graph] of graphs) {
        const roleId = sanitizeId(role);
        for (const state of graph.states) {
            const transMap = buildTransitionMap(graph);
            const transitions = transMap.get(state.id) ?? [];
            const stateId = sanitizeId(state.id);
            if (state.data.kind === "terminal") {
                actionNames.push(`${roleId}_${stateId}`);
            }
            else if (transitions.length > 0) {
                actionNames.push(`${roleId}_${stateId}`);
            }
        }
    }
    // Next state relation
    lines.push(`Next ==`);
    if (actionNames.length > 0) {
        lines.push(`  \\/ ` + actionNames.join(`\n  \\/ `));
    }
    else {
        lines.push(`  FALSE`);
    }
    lines.push(``);
    // Spec
    lines.push(`Spec == Init /\\ [][Next]_vars /\\ WF_vars(Next)`);
    lines.push(``);
    // Properties
    lines.push(`\\* All roles eventually complete`);
    lines.push(`AllCompleted == \\A r \\in {${roleSet}} : status[r] \\in {"completed", "failed"}`);
    lines.push(``);
    lines.push(`\\* Liveness: protocol eventually completes`);
    lines.push(`Completion == <>AllCompleted`);
    lines.push(``);
    lines.push(`\\* Safety: no messages left in channels when all done`);
    lines.push(`NoOrphanMessages ==`);
    lines.push(`  AllCompleted => \\A p \\in ChannelPairs : Len(channels[p]) = 0`);
    lines.push(``);
    lines.push(`====`);
    return lines.join("\n") + "\n";
}
/**
 * Generate a TLC config file for the TLA+ module.
 */
export function generateTLCConfig(protocolName, roles) {
    const roleSet = roles.map((r) => `"${r}"`).join(", ");
    const lines = [];
    lines.push(`SPECIFICATION Spec`);
    lines.push(``);
    lines.push(`CONSTANTS`);
    lines.push(`  Roles = {${roleSet}}`);
    lines.push(``);
    lines.push(`PROPERTIES`);
    lines.push(`  Completion`);
    lines.push(``);
    lines.push(`INVARIANTS`);
    lines.push(`  NoOrphanMessages`);
    return lines.join("\n") + "\n";
}
