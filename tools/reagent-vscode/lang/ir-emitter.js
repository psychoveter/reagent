/**
 * Reagent IR Emitter — v0.0.14
 *
 * Transforms AST nodes into IR:
 * - ProtocolDef → set of IRGraphs (one per role)
 * - RoleDef → RoleIR (rich behavioral contract with lifecycle)
 * - AgentDef → AgentIR (deployment binding referencing a role, with metadata)
 */
// ── Helpers ─────────────────────────────────────────────────────────
/** Detect if a zone body contains `await` keyword (simple heuristic). */
function zoneContainsAwait(body) {
    return /\bawait\b/.test(body);
}
export function emitIR(protocol) {
    const errors = [];
    const graphs = new Map();
    const sourceMap = [];
    const langMap = new Map();
    for (const p of protocol.participants) {
        langMap.set(p.name, p.lang);
    }
    const participants = protocol.participants.map(p => ({
        name: p.name,
        lang: p.lang,
        binding: p.binding ?? "static",
        cardinality: p.cardinality ?? "single",
        initiator: p.initiator === true,
    }));
    const participantMap = new Map(participants.map((p) => [p.name, p]));
    const initiatorParticipant = participants.find(p => p.initiator);
    // Validate initiator
    const initiatorCount = participants.filter(p => p.initiator).length;
    if (initiatorCount === 0) {
        errors.push(`Protocol "${protocol.name}" has no initiator participant. Mark one participant with the "initiator" modifier.`);
    }
    else if (initiatorCount > 1) {
        errors.push(`Protocol "${protocol.name}" has ${initiatorCount} initiator participants. Exactly one is required.`);
    }
    if (initiatorParticipant) {
        if (initiatorParticipant.binding !== "static") {
            errors.push(`Protocol "${protocol.name}": initiator "${initiatorParticipant.name}" must be static (initiator implies static single).`);
        }
        if (initiatorParticipant.cardinality !== "single") {
            errors.push(`Protocol "${protocol.name}": initiator "${initiatorParticipant.name}" must be single (initiator implies static single).`);
        }
    }
    const triggers = (protocol.triggers ?? []).map(t => {
        const resolveMap = t.resolveDecls
            ? Object.fromEntries(t.resolveDecls.map(rd => [rd.role, rd.pipeline]))
            : undefined;
        switch (t.triggerKind) {
            case "invoke": return {
                kind: "invoke",
                withType: t.withType,
                ...(t.inputExpr != null && { inputExpr: t.inputExpr }),
                ...(resolveMap != null && { resolveMap }),
            };
            case "cron": return {
                kind: "cron",
                cron: t.cronExpr,
                ...(t.inputExpr != null && { inputExpr: t.inputExpr }),
                ...(resolveMap != null && { resolveMap }),
            };
            case "event": return {
                kind: "event",
                topic: t.topic,
                withType: t.withType,
                ...(t.inputExpr != null && { inputExpr: t.inputExpr }),
                ...(resolveMap != null && { resolveMap }),
            };
        }
    });
    const invocable = triggers.some(t => t.kind === "invoke");
    if (triggers.length === 0) {
        errors.push(`Protocol "${protocol.name}" has no triggers. Declare at least one trigger (e.g. trigger on invoke with MsgType).`);
    }
    // Validate resolve: static participants must have resolve in every trigger
    for (const t of protocol.triggers ?? []) {
        const resolvedRoles = new Set((t.resolveDecls ?? []).map(rd => rd.role));
        for (const p of participants) {
            if (p.binding === "static" && !resolvedRoles.has(p.name)) {
                errors.push(`Protocol "${protocol.name}": static participant "${p.name}" requires a "resolve" declaration in trigger on ${t.triggerKind}.`);
            }
            if (p.binding === "dynamic" && resolvedRoles.has(p.name)) {
                errors.push(`Protocol "${protocol.name}": dynamic participant "${p.name}" must not have a "resolve" in trigger — it is resolved at runtime.`);
            }
        }
    }
    for (const p of protocol.participants) {
        const builder = new GraphBuilder(protocol.name, p.name, p.lang, langMap, participantMap, errors);
        builder.emitBody(protocol.body);
        builder.finalize();
        const graph = builder.toGraph();
        graph.participants = participants;
        graph.supervisionStrategy = protocol.supervisionStrategy ?? "scoped";
        if (triggers.length > 0) {
            graph.triggers = triggers;
            graph.invocable = invocable;
        }
        if (p.lang === "*") {
            for (const s of graph.states) {
                if (s.data.kind === "action") {
                    errors.push(`Zone block forbidden for wildcard [*] participant "${p.name}" in protocol "${protocol.name}"`);
                    break;
                }
            }
        }
        graphs.set(p.name, graph);
        sourceMap.push(...builder.getSourceMap());
    }
    return { ok: errors.length === 0, graphs, errors, sourceMap };
}
/**
 * Flatten a role's `extends` chain and produce a resolved RoleIR.
 * Plays are merged (parent first, deduped). Init bodies are chained (parent first).
 * Handlers from parent and child both fire.
 */
export function emitRoleIR(role, roleMap) {
    const errors = [];
    const { plays, initAction, lifecycleHandlers, lang } = flattenRole(role, roleMap, errors, new Set());
    return {
        ok: errors.length === 0,
        roleIR: {
            roleName: role.name,
            lang,
            extends: role.extends,
            plays,
            initAction,
            lifecycleHandlers,
        },
        errors,
    };
}
function flattenRole(role, roleMap, errors, visited) {
    if (visited.has(role.name)) {
        errors.push(`Circular extends chain detected involving role "${role.name}"`);
        return { plays: [], lifecycleHandlers: [], lang: role.lang };
    }
    visited.add(role.name);
    let parentFlat;
    if (role.extends) {
        const parentDef = roleMap?.get(role.extends);
        if (!parentDef) {
            errors.push(`Role "${role.name}" extends unknown role "${role.extends}"`);
        }
        else {
            parentFlat = flattenRole(parentDef, roleMap, errors, visited);
            if (role.lang && parentFlat.lang && parentFlat.lang !== "*" && role.lang !== parentFlat.lang) {
                errors.push(`Role "${role.name}" lang [${role.lang}] conflicts with parent "${role.extends}" lang [${parentFlat.lang}]`);
            }
        }
    }
    const parentPlays = parentFlat?.plays ?? [];
    const ownPlays = role.plays.map(p => ({
        protocolName: p.protocolName,
        roleName: p.roleName,
    }));
    const plays = [...parentPlays];
    for (const op of ownPlays) {
        if (!plays.find(p => p.protocolName === op.protocolName && p.roleName === op.roleName)) {
            plays.push(op);
        }
    }
    const effectiveLang = role.lang ?? parentFlat?.lang;
    const parentInit = parentFlat?.initAction;
    const ownInit = role.init ? { body: role.init.body, lang: effectiveLang ?? "*" } : undefined;
    let initAction;
    if (parentInit && ownInit) {
        initAction = { body: parentInit.body + "\n" + ownInit.body, lang: ownInit.lang };
    }
    else {
        initAction = ownInit ?? parentInit;
    }
    const parentHandlers = parentFlat?.lifecycleHandlers ?? [];
    const ownHandlers = role.handlers.map(h => ({
        event: h.event,
        protocolFilter: h.protocolFilter,
        action: { body: h.body, lang: effectiveLang ?? "*" },
    }));
    const lifecycleHandlers = [...parentHandlers, ...ownHandlers];
    return { plays, initAction, lifecycleHandlers, lang: effectiveLang };
}
/**
 * Produce a thin AgentIR that just references the role it runs.
 * Validates the role exists and lang tags are compatible.
 */
export function emitAgentIR(agent, roleMap) {
    const errors = [];
    const roleFile = `${agent.runs}.role.json`;
    const roleDef = roleMap.get(agent.runs);
    if (!roleDef) {
        errors.push(`Agent "${agent.name}" runs unknown role "${agent.runs}"`);
        const lang = agent.lang ?? "*";
        return {
            ok: false,
            agentIR: { agentName: agent.name, lang, roleName: agent.runs, roleFile },
            errors,
        };
    }
    const roleResult = emitRoleIR(roleDef, roleMap);
    errors.push(...roleResult.errors);
    const rIR = roleResult.roleIR;
    const lang = agent.lang ?? rIR.lang ?? "*";
    if (agent.lang && rIR.lang && rIR.lang !== "*" && agent.lang !== rIR.lang) {
        errors.push(`Agent "${agent.name}" lang [${agent.lang}] conflicts with role "${agent.runs}" lang [${rIR.lang}]`);
    }
    return {
        ok: errors.length === 0,
        agentIR: {
            agentName: agent.name,
            lang,
            roleName: agent.runs,
            roleFile,
            ...(agent.tags != null && { tags: agent.tags }),
            ...(agent.capabilities != null && { capabilities: agent.capabilities }),
            ...(agent.labels != null && { labels: agent.labels }),
        },
        errors,
    };
}
export function emitAgentRegistrationIR(agent) {
    return {
        agentName: agent.name,
        roleName: agent.runs,
        ...(agent.tags != null && { tags: agent.tags }),
        ...(agent.capabilities != null && { capabilities: agent.capabilities }),
        ...(agent.labels != null && { labels: agent.labels }),
    };
}
// ── Message Schema Emitter ─────────────────────────────────────────
export function emitMessageSchema(msg) {
    return {
        name: msg.name,
        fields: msg.fields.map((f) => ({
            name: f.name,
            type: f.type,
            optional: f.optional,
        })),
    };
}
// ── Graph builder (per-role) ────────────────────────────────────────
let globalIdCounter = 0;
function nextId(prefix) {
    return `${prefix}_${++globalIdCounter}`;
}
/**
 * Reset the global ID counter (useful for deterministic tests).
 */
export function resetIdCounter() {
    globalIdCounter = 0;
}
class GraphBuilder {
    protocolName;
    role;
    lang;
    langMap;
    participants;
    errors;
    states = [];
    transitions = [];
    initialStateId;
    terminalStateIds = [];
    sourceMapEntries = [];
    activeScatterRoles = [];
    /** The "current" state ID — the last state emitted, where the next transition will start from. */
    currentId;
    constructor(protocolName, role, lang, langMap, participants, errors) {
        this.protocolName = protocolName;
        this.role = role;
        this.lang = lang;
        this.langMap = langMap;
        this.participants = participants;
        this.errors = errors;
        const initId = nextId("init");
        this.addState(initId, { kind: "initial" });
        this.initialStateId = initId;
        this.currentId = initId;
    }
    addState(id, data, loc) {
        this.states.push({ id, kind: data.kind, data });
        if (loc) {
            this.sourceMapEntries.push({
                stateId: id,
                protocolName: this.protocolName,
                role: this.role,
                file: "",
                line: loc.start.line,
                column: loc.start.col,
            });
        }
    }
    getSourceMap() {
        return this.sourceMapEntries;
    }
    addTransition(from, to, label) {
        this.transitions.push({ from, to, label });
    }
    advance(stateId, data, label = { kind: "default" }, loc) {
        this.addState(stateId, data, loc);
        this.addTransition(this.currentId, stateId, label);
        this.currentId = stateId;
        return stateId;
    }
    /** Emit all body items sequentially. */
    emitBody(items) {
        for (const item of items) {
            this.emitItem(item);
        }
    }
    emitItem(item) {
        switch (item.kind) {
            case "MessageStmt": return this.emitMessage(item);
            case "AgentZone": return this.emitZone(item);
            case "AltStmt": return this.emitAlt(item);
            case "LoopStmt": return this.emitLoop(item);
            case "ParStmt": return this.emitPar(item);
            case "WaitStmt": return this.emitWait(item);
            case "TryStmt": return this.emitTry(item);
            case "InvokeStmt": return this.emitInvoke(item);
            case "SpawnStmt": return this.emitSpawn(item);
            case "ScatterStmt": return this.emitScatter(item);
        }
    }
    // ── Message ─────────────────────────────────────────────────────
    emitMessage(msg) {
        const isSender = msg.from === this.role;
        const isReceiver = msg.to === this.role;
        const targetParticipant = this.participants.get(msg.to);
        if (!isSender && !isReceiver) {
            // This role is not involved in this message — skip but maintain control flow continuity
            return;
        }
        const narrowedByScatter = this.activeScatterRoles.includes(msg.to);
        if (isSender && targetParticipant?.cardinality === "many" && !narrowedByScatter) {
            this.errors.push(`Protocol "${this.protocolName}": direct send ${msg.from} -> ${msg.to} (${msg.messageName}) is ambiguous because participant "${msg.to}" is declared many. Use scatter or explicit narrowing.`);
        }
        if (isSender) {
            let preSendZone;
            if (msg.props) {
                for (const h of msg.props.hooks) {
                    if (h.hookType === "onSend")
                        preSendZone = h.body;
                }
            }
            const id = nextId("send");
            this.advance(id, {
                kind: "send",
                to: msg.to,
                arrow: msg.arrow,
                messageName: msg.messageName,
                preSendZone,
                ...(preSendZone && zoneContainsAwait(preSendZone) ? { preSendAsync: true } : {}),
            }, { kind: "default" }, msg.loc);
        }
        if (isReceiver) {
            let postReceiveZone;
            if (msg.props) {
                for (const h of msg.props.hooks) {
                    if (h.hookType === "onReceive")
                        postReceiveZone = h.body;
                }
            }
            const pattern = msg.props?.pairs && msg.props.pairs.length > 0
                ? Object.fromEntries(msg.props.pairs.map(p => [p.key, p.value]))
                : undefined;
            const id = nextId("recv");
            this.advance(id, {
                kind: "receive",
                from: msg.from,
                arrow: msg.arrow,
                messageName: msg.messageName,
                postReceiveZone,
                ...(postReceiveZone && zoneContainsAwait(postReceiveZone) ? { postReceiveAsync: true } : {}),
                pattern,
            }, { kind: "default" }, msg.loc);
        }
    }
    // ── Agent zone ──────────────────────────────────────────────────
    emitZone(zone) {
        if (zone.agent !== this.role)
            return;
        const id = nextId("act");
        const isAsync = zoneContainsAwait(zone.body);
        this.advance(id, {
            kind: "action",
            body: zone.body,
            lang: zone.lang,
            ...(isAsync ? { async: true } : {}),
        }, { kind: "default" }, zone.loc);
    }
    // ── Alt ─────────────────────────────────────────────────────────
    emitAlt(alt) {
        // Create a guard (decision) node
        const guardId = nextId("xor");
        this.advance(guardId, { kind: "guard", guardType: "xor" });
        // Create a merge (join) node after all branches
        const mergeId = nextId("merge");
        const savedCurrent = this.currentId;
        for (let i = 0; i < alt.branches.length; i++) {
            const branch = alt.branches[i];
            this.currentId = guardId;
            // Determine the transition label based on the guard
            let label;
            switch (branch.guard.kind) {
                case "AltMessageGuard": {
                    const g = branch.guard;
                    const pattern = g.whereClause
                        ?? (g.props?.pairs
                            ? Object.fromEntries(g.props.pairs.map(p => [p.key, p.value]))
                            : undefined);
                    label = { kind: "message", messageName: g.messageName, pattern };
                    // For the receiver role, emit a receive state at the branch entry
                    if (g.to === this.role) {
                        const recvId = nextId("recv");
                        this.addState(recvId, {
                            kind: "receive",
                            from: g.from,
                            arrow: g.arrow,
                            messageName: g.messageName,
                            pattern,
                        });
                        this.addTransition(guardId, recvId, label);
                        this.currentId = recvId;
                    }
                    else if (g.from === this.role) {
                        // The sender role sees this as "outgoing message selected"
                        const sendId = nextId("send");
                        this.addState(sendId, {
                            kind: "send",
                            to: g.to,
                            arrow: g.arrow,
                            messageName: g.messageName,
                        });
                        this.addTransition(guardId, sendId, label);
                        this.currentId = sendId;
                    }
                    else {
                        // This role is not involved in this branch's guard message
                        // Still emit branch body for this role
                        const passId = nextId("pass");
                        this.addState(passId, { kind: "guard", guardType: "expression" });
                        this.addTransition(guardId, passId, { kind: "branch", branchIndex: i });
                        this.currentId = passId;
                    }
                    break;
                }
                case "AltExprGuard":
                    label = { kind: "expression", expr: branch.guard.expr };
                    // Emit a passthrough for this branch
                    const exprEntry = nextId("guard");
                    this.addState(exprEntry, { kind: "guard", guardType: "expression", expr: branch.guard.expr });
                    this.addTransition(guardId, exprEntry, label);
                    this.currentId = exprEntry;
                    break;
                case "AltTimeoutGuard": {
                    const timerId = nextId("timer");
                    this.addState(timerId, { kind: "timer", duration: branch.guard.duration });
                    this.addTransition(guardId, timerId, { kind: "timeout", duration: branch.guard.duration });
                    this.currentId = timerId;
                    break;
                }
                case "AltElseGuard":
                    label = { kind: "else" };
                    const elseEntry = nextId("else");
                    this.addState(elseEntry, { kind: "guard", guardType: "expression" });
                    this.addTransition(guardId, elseEntry, label);
                    this.currentId = elseEntry;
                    break;
            }
            // Emit branch body
            this.emitBody(branch.body);
            // Connect branch end to merge
            this.addTransition(this.currentId, mergeId, { kind: "default" });
        }
        // Add merge state
        this.addState(mergeId, { kind: "guard", guardType: "expression" });
        this.currentId = mergeId;
    }
    // ── Loop ────────────────────────────────────────────────────────
    emitLoop(loop) {
        // Guard node at top of loop
        const guardId = nextId("loop_guard");
        this.advance(guardId, { kind: "guard", guardType: "expression", expr: loop.guard });
        // Exit node (when guard is false)
        const exitId = nextId("loop_exit");
        // Save current and set to guard
        const entryId = this.currentId;
        // True branch: enter body
        this.currentId = guardId;
        this.emitBody(loop.body);
        // Back-edge: end of body → guard
        this.addTransition(this.currentId, guardId, { kind: "default" });
        // False branch: guard → exit
        this.addState(exitId, { kind: "guard", guardType: "expression" });
        this.addTransition(guardId, exitId, { kind: "else" });
        this.currentId = exitId;
    }
    // ── Par ─────────────────────────────────────────────────────────
    emitPar(par) {
        const forkId = nextId("fork");
        const branchStartIds = [];
        // Fork state
        this.advance(forkId, { kind: "fork", branchStartIds: [] /* filled below */ });
        const joinId = nextId("join");
        for (let i = 0; i < par.branches.length; i++) {
            // Each branch starts from a fresh entry
            const branchEntryId = nextId("par_entry");
            this.addState(branchEntryId, { kind: "guard", guardType: "expression" });
            this.addTransition(forkId, branchEntryId, { kind: "branch", branchIndex: i });
            branchStartIds.push(branchEntryId);
            this.currentId = branchEntryId;
            this.emitBody(par.branches[i].body);
            // Connect branch end to join
            this.addTransition(this.currentId, joinId, { kind: "default" });
        }
        // Update fork data with actual branch start IDs
        const forkState = this.states.find(s => s.id === forkId);
        forkState.data.branchStartIds = branchStartIds;
        // Join state
        this.addState(joinId, { kind: "join", branchCount: par.branches.length });
        this.currentId = joinId;
    }
    // ── Wait ────────────────────────────────────────────────────────
    emitWait(wait) {
        const id = nextId("timer");
        this.advance(id, { kind: "timer", duration: wait.duration }, { kind: "default" }, wait.loc);
    }
    // ── Try/catch ───────────────────────────────────────────────────
    emitTry(tryStmt) {
        // Normal path
        const tryEntryId = this.currentId;
        this.emitBody(tryStmt.tryBody);
        const tryExitId = this.currentId;
        // Merge point after try/catch
        const mergeId = nextId("try_merge");
        // Normal path → merge
        this.addTransition(tryExitId, mergeId, { kind: "default" });
        // Error path: any state in the try body can transition to catch on error
        // We model this as: tryEntry has an error edge to catch entry
        const catchEntryId = nextId("catch");
        this.addState(catchEntryId, { kind: "error", label: tryStmt.catchLabel });
        this.addTransition(tryEntryId, catchEntryId, { kind: "error" });
        this.currentId = catchEntryId;
        this.emitBody(tryStmt.catchBody);
        // Catch path → merge
        this.addTransition(this.currentId, mergeId, { kind: "default" });
        this.addState(mergeId, { kind: "guard", guardType: "expression" });
        this.currentId = mergeId;
    }
    // ── Invoke (sync and async) ─────────────────────────────────────
    emitInvoke(stmt) {
        if (stmt.callerRole !== this.role)
            return;
        if (stmt.async) {
            const id = nextId("async_invoke");
            this.advance(id, {
                kind: "async_invoke",
                protocolName: stmt.protocolName,
                input: stmt.input,
                roleMapping: stmt.roleMapping,
            }, { kind: "default" }, stmt.loc);
        }
        else {
            const id = nextId("invoke");
            this.advance(id, {
                kind: "invoke",
                protocolName: stmt.protocolName,
                input: stmt.input,
                roleMapping: stmt.roleMapping,
                resultTarget: stmt.resultTarget,
            }, { kind: "default" }, stmt.loc);
        }
    }
    // ── Spawn (role instantiation) ──────────────────────────────────
    emitSpawn(stmt) {
        if (stmt.callerRole !== this.role)
            return;
        const id = nextId("spawn");
        this.advance(id, {
            kind: "spawn",
            roleName: stmt.roleName,
            config: stmt.config,
            bindAs: stmt.bindAs,
            resultTarget: stmt.resultTarget,
            persistent: stmt.persistent === true,
        }, { kind: "default" }, stmt.loc);
    }
    // ── Scatter ────────────────────────────────────────────────────
    emitScatter(stmt) {
        const itemParticipant = this.participants.get(stmt.itemRole);
        if (!itemParticipant) {
            this.errors.push(`Protocol "${this.protocolName}": scatter target "${stmt.itemRole}" is not a declared participant.`);
            return;
        }
        if (itemParticipant.cardinality !== "many") {
            this.errors.push(`Protocol "${this.protocolName}": scatter target "${stmt.itemRole}" must be declared many.`);
        }
        if (this.role === stmt.itemRole) {
            // The item-role participant runs a single linear branch (no scatter wrapper).
            // The scatter orchestration is the initiator's concern.
            this.activeScatterRoles.push(stmt.itemRole);
            this.emitBody(stmt.body);
            this.activeScatterRoles.pop();
            return;
        }
        const forkId = nextId("scatter_fork");
        const branchStartIds = [];
        this.advance(forkId, { kind: "scatter", collection: stmt.collection, itemRole: stmt.itemRole, branchStartIds: [] });
        const joinId = nextId("scatter_join");
        const branchEntryId = nextId("scatter_entry");
        this.addState(branchEntryId, { kind: "guard", guardType: "expression" });
        this.addTransition(forkId, branchEntryId, { kind: "branch", branchIndex: 0 });
        branchStartIds.push(branchEntryId);
        this.currentId = branchEntryId;
        this.activeScatterRoles.push(stmt.itemRole);
        this.emitBody(stmt.body);
        this.activeScatterRoles.pop();
        this.addTransition(this.currentId, joinId, { kind: "default" });
        const scatterState = this.states.find(s => s.id === forkId);
        scatterState.data.branchStartIds = branchStartIds;
        this.addState(joinId, { kind: "join", branchCount: 1 });
        this.currentId = joinId;
    }
    // ── Finalize ────────────────────────────────────────────────────
    finalize() {
        const termId = nextId("end");
        this.addState(termId, { kind: "terminal", status: "completed" });
        this.addTransition(this.currentId, termId, { kind: "default" });
        this.terminalStateIds.push(termId);
    }
    toGraph() {
        return {
            protocolName: this.protocolName,
            role: this.role,
            lang: this.lang,
            states: this.states,
            transitions: this.transitions,
            initialStateId: this.initialStateId,
            terminalStateIds: this.terminalStateIds,
        };
    }
}
