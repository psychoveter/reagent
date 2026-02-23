/**
 * Reagent IR Emitter — v0.0.8
 *
 * Transforms AST nodes into IR:
 * - ProtocolDef → set of IRGraphs (one per role)
 * - RoleDef → RoleIR (rich behavioral contract with lifecycle)
 * - AgentDef → AgentIR (thin deployment binding referencing a role)
 */

import type {
  AgentDef,
  AgentZone,
  AltBranch,
  AltStmt,
  InvokeStmt,
  LangTag,
  Loc,
  LoopStmt,
  MessageDef,
  MessageStmt,
  ParStmt,
  ParticipantDecl,
  ProtocolDef,
  ProtocolItem,
  RoleDef,
  ScatterStmt,
  SpawnStmt,
  TryStmt,
  WaitStmt,
} from "./ast.js";

import type {
  AgentAction,
  AgentIR,
  AgentLifecycleHandler,
  AgentPlaysBinding,
  IRFieldSchema,
  IRGraph,
  IRMessageSchema,
  IRState,
  IRStateData,
  IRTransition,
  IRTransitionLabel,
  RoleIR,
} from "./ir.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Detect if a zone body contains `await` keyword (simple heuristic). */
function zoneContainsAwait(body: string): boolean {
  return /\bawait\b/.test(body);
}

// ── Public API ──────────────────────────────────────────────────────

export type SourceMapEntry = {
  stateId: string;
  protocolName: string;
  role: string;
  file: string;
  line: number;
  column: number;
};

export type EmitResult = {
  ok: boolean;
  graphs: Map<string, IRGraph>;
  errors: string[];
  sourceMap: SourceMapEntry[];
};

export function emitIR(protocol: ProtocolDef): EmitResult {
  const errors: string[] = [];
  const graphs = new Map<string, IRGraph>();
  const sourceMap: SourceMapEntry[] = [];

  const langMap = new Map<string, LangTag>();
  for (const p of protocol.participants) {
    langMap.set(p.name, p.lang);
  }

  for (const p of protocol.participants) {
    const builder = new GraphBuilder(protocol.name, p.name, p.lang, langMap);
    builder.emitBody(protocol.body);
    builder.finalize();
    const graph = builder.toGraph();

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

// ── Role IR Emitter ─────────────────────────────────────────────────

export type RoleEmitResult = {
  ok: boolean;
  roleIR: RoleIR;
  errors: string[];
};

/**
 * Flatten a role's `extends` chain and produce a resolved RoleIR.
 * Plays are merged (parent first, deduped). Init bodies are chained (parent first).
 * Handlers from parent and child both fire.
 */
export function emitRoleIR(role: RoleDef, roleMap?: Map<string, RoleDef>): RoleEmitResult {
  const errors: string[] = [];
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

type FlatRole = {
  plays: AgentPlaysBinding[];
  initAction?: AgentAction;
  lifecycleHandlers: AgentLifecycleHandler[];
  lang?: LangTag;
};

function flattenRole(
  role: RoleDef,
  roleMap: Map<string, RoleDef> | undefined,
  errors: string[],
  visited: Set<string>,
): FlatRole {
  if (visited.has(role.name)) {
    errors.push(`Circular extends chain detected involving role "${role.name}"`);
    return { plays: [], lifecycleHandlers: [], lang: role.lang };
  }
  visited.add(role.name);

  let parentFlat: FlatRole | undefined;
  if (role.extends) {
    const parentDef = roleMap?.get(role.extends);
    if (!parentDef) {
      errors.push(`Role "${role.name}" extends unknown role "${role.extends}"`);
    } else {
      parentFlat = flattenRole(parentDef, roleMap, errors, visited);
      if (role.lang && parentFlat.lang && parentFlat.lang !== "*" && role.lang !== parentFlat.lang) {
        errors.push(`Role "${role.name}" lang [${role.lang}] conflicts with parent "${role.extends}" lang [${parentFlat.lang}]`);
      }
    }
  }

  const parentPlays = parentFlat?.plays ?? [];
  const ownPlays: AgentPlaysBinding[] = role.plays.map(p => ({
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
  const ownInit = role.init ? { body: role.init.body, lang: effectiveLang ?? ("*" as LangTag) } : undefined;
  let initAction: AgentAction | undefined;
  if (parentInit && ownInit) {
    initAction = { body: parentInit.body + "\n" + ownInit.body, lang: ownInit.lang };
  } else {
    initAction = ownInit ?? parentInit;
  }

  const parentHandlers = parentFlat?.lifecycleHandlers ?? [];
  const ownHandlers: AgentLifecycleHandler[] = role.handlers.map(h => ({
    event: h.event,
    protocolFilter: h.protocolFilter,
    action: { body: h.body, lang: effectiveLang ?? ("*" as LangTag) },
  }));
  const lifecycleHandlers = [...parentHandlers, ...ownHandlers];

  return { plays, initAction, lifecycleHandlers, lang: effectiveLang };
}

// ── Agent IR Emitter ────────────────────────────────────────────────

export type AgentEmitResult = {
  ok: boolean;
  agentIR: AgentIR;
  errors: string[];
};

/**
 * Produce a thin AgentIR that just references the role it runs.
 * Validates the role exists and lang tags are compatible.
 */
export function emitAgentIR(agent: AgentDef, roleMap: Map<string, RoleDef>): AgentEmitResult {
  const errors: string[] = [];
  const roleFile = `${agent.runs}.role.json`;

  const roleDef = roleMap.get(agent.runs);
  if (!roleDef) {
    errors.push(`Agent "${agent.name}" runs unknown role "${agent.runs}"`);
    const lang = agent.lang ?? ("*" as LangTag);
    return {
      ok: false,
      agentIR: { agentName: agent.name, lang, roleName: agent.runs, roleFile },
      errors,
    };
  }

  const roleResult = emitRoleIR(roleDef, roleMap);
  errors.push(...roleResult.errors);
  const rIR = roleResult.roleIR;

  const lang = agent.lang ?? rIR.lang ?? ("*" as LangTag);
  if (agent.lang && rIR.lang && rIR.lang !== "*" && agent.lang !== rIR.lang) {
    errors.push(`Agent "${agent.name}" lang [${agent.lang}] conflicts with role "${agent.runs}" lang [${rIR.lang}]`);
  }

  return {
    ok: errors.length === 0,
    agentIR: { agentName: agent.name, lang, roleName: agent.runs, roleFile },
    errors,
  };
}

// ── Message Schema Emitter ─────────────────────────────────────────

export function emitMessageSchema(msg: MessageDef): IRMessageSchema {
  return {
    name: msg.name,
    fields: msg.fields.map((f): IRFieldSchema => ({
      name: f.name,
      type: f.type,
      optional: f.optional,
    })),
  };
}

// ── Graph builder (per-role) ────────────────────────────────────────

let globalIdCounter = 0;

function nextId(prefix: string): string {
  return `${prefix}_${++globalIdCounter}`;
}

/**
 * Reset the global ID counter (useful for deterministic tests).
 */
export function resetIdCounter(): void {
  globalIdCounter = 0;
}

class GraphBuilder {
  readonly protocolName: string;
  readonly role: string;
  readonly lang: LangTag;
  readonly langMap: Map<string, LangTag>;

  states: IRState[] = [];
  transitions: IRTransition[] = [];
  initialStateId: string;
  terminalStateIds: string[] = [];
  private sourceMapEntries: SourceMapEntry[] = [];

  /** The "current" state ID — the last state emitted, where the next transition will start from. */
  private currentId: string;

  constructor(protocolName: string, role: string, lang: LangTag, langMap: Map<string, LangTag>) {
    this.protocolName = protocolName;
    this.role = role;
    this.lang = lang;
    this.langMap = langMap;

    const initId = nextId("init");
    this.addState(initId, { kind: "initial" });
    this.initialStateId = initId;
    this.currentId = initId;
  }

  private addState(id: string, data: IRStateData, loc?: Loc): void {
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

  getSourceMap(): SourceMapEntry[] {
    return this.sourceMapEntries;
  }

  private addTransition(from: string, to: string, label: IRTransitionLabel): void {
    this.transitions.push({ from, to, label });
  }

  private advance(stateId: string, data: IRStateData, label: IRTransitionLabel = { kind: "default" }, loc?: Loc): string {
    this.addState(stateId, data, loc);
    this.addTransition(this.currentId, stateId, label);
    this.currentId = stateId;
    return stateId;
  }

  /** Emit all body items sequentially. */
  emitBody(items: ProtocolItem[]): void {
    for (const item of items) {
      this.emitItem(item);
    }
  }

  private emitItem(item: ProtocolItem): void {
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

  private emitMessage(msg: MessageStmt): void {
    const isSender = msg.from === this.role;
    const isReceiver = msg.to === this.role;

    if (!isSender && !isReceiver) {
      // This role is not involved in this message — skip but maintain control flow continuity
      return;
    }

    if (isSender) {
      let preSendZone: string | undefined;
      if (msg.props) {
        for (const h of msg.props.hooks) {
          if (h.hookType === "onSend") preSendZone = h.body;
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
        propagateFlow: true,
      }, { kind: "default" }, msg.loc);
    }

    if (isReceiver) {
      let postReceiveZone: string | undefined;
      if (msg.props) {
        for (const h of msg.props.hooks) {
          if (h.hookType === "onReceive") postReceiveZone = h.body;
        }
      }

      const pattern: Record<string, string> | undefined =
        msg.props?.pairs && msg.props.pairs.length > 0
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
        propagateFlow: true,
      }, { kind: "default" }, msg.loc);
    }
  }

  // ── Agent zone ──────────────────────────────────────────────────

  private emitZone(zone: AgentZone): void {
    if (zone.agent !== this.role) return;

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

  private emitAlt(alt: AltStmt): void {
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
      let label: IRTransitionLabel;
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
          } else if (g.from === this.role) {
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
          } else {
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

  private emitLoop(loop: LoopStmt): void {
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

  private emitPar(par: ParStmt): void {
    const forkId = nextId("fork");
    const branchStartIds: string[] = [];

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
    const forkState = this.states.find(s => s.id === forkId)!;
    (forkState.data as any).branchStartIds = branchStartIds;

    // Join state
    this.addState(joinId, { kind: "join", branchCount: par.branches.length });
    this.currentId = joinId;
  }

  // ── Wait ────────────────────────────────────────────────────────

  private emitWait(wait: WaitStmt): void {
    const id = nextId("timer");
    this.advance(id, { kind: "timer", duration: wait.duration }, { kind: "default" }, wait.loc);
  }

  // ── Try/catch ───────────────────────────────────────────────────

  private emitTry(tryStmt: TryStmt): void {
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

  // ── Invoke ──────────────────────────────────────────────────────

  private emitInvoke(stmt: InvokeStmt): void {
    if (stmt.callerRole !== this.role) return;

    const id = nextId("invoke");
    this.advance(id, {
      kind: "invoke",
      protocolName: stmt.protocolName,
      input: stmt.input,
      roleMapping: stmt.roleMapping,
      resultTarget: stmt.resultTarget,
    }, { kind: "default" }, stmt.loc);
  }

  // ── Spawn ──────────────────────────────────────────────────────

  private emitSpawn(stmt: SpawnStmt): void {
    if (stmt.callerRole !== this.role) return;

    const id = nextId("spawn");
    this.advance(id, {
      kind: "spawn",
      protocolName: stmt.protocolName,
      input: stmt.input,
      roleMapping: stmt.roleMapping,
    }, { kind: "default" }, stmt.loc);
  }

  // ── Scatter ────────────────────────────────────────────────────

  private emitScatter(stmt: ScatterStmt): void {
    const forkId = nextId("scatter_fork");
    const branchStartIds: string[] = [];

    this.advance(forkId, { kind: "scatter", collection: stmt.collection, itemRole: stmt.itemRole, branchStartIds: [] });

    const joinId = nextId("scatter_join");

    const branchEntryId = nextId("scatter_entry");
    this.addState(branchEntryId, { kind: "guard", guardType: "expression" });
    this.addTransition(forkId, branchEntryId, { kind: "branch", branchIndex: 0 });
    branchStartIds.push(branchEntryId);

    this.currentId = branchEntryId;
    this.emitBody(stmt.body);

    this.addTransition(this.currentId, joinId, { kind: "default" });

    const scatterState = this.states.find(s => s.id === forkId)!;
    (scatterState.data as any).branchStartIds = branchStartIds;

    this.addState(joinId, { kind: "join", branchCount: 1 });
    this.currentId = joinId;
  }

  // ── Finalize ────────────────────────────────────────────────────

  finalize(): void {
    const termId = nextId("end");
    this.addState(termId, { kind: "terminal", status: "completed" });
    this.addTransition(this.currentId, termId, { kind: "default" });
    this.terminalStateIds.push(termId);
  }

  toGraph(): IRGraph {
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
