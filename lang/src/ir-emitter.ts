/**
 * Reagent IR Emitter — v0.0.14
 *
 * Transforms AST nodes into IR:
 * - ProtocolDef → set of IRGraphs (one per role)
 * - RoleDef → RoleIR (rich behavioral contract with lifecycle)
 * - AgentDef → AgentIR (deployment binding referencing a role, with metadata)
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
  AgentRegistrationIR,
  AgentLifecycleHandler,
  AgentPlaysBinding,
  IRFieldSchema,
  IRGraph,
  IRMessageSchema,
  IRState,
  IRStateData,
  IRTransition,
  IRTransitionLabel,
  ParticipantIR,
  ResolvePolicyIR,
  RoleIR,
  TriggerIR,
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

  const participants: ParticipantIR[] = protocol.participants.map(p => ({
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
  } else if (initiatorCount > 1) {
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

  const triggers: TriggerIR[] = (protocol.triggers ?? []).map(t => {
    const resolveMap: Record<string, ResolvePolicyIR> | undefined = t.resolveDecls
      ? Object.fromEntries(t.resolveDecls.map(rd => [rd.role, rd.pipeline as ResolvePolicyIR]))
      : undefined;

    switch (t.triggerKind) {
      case "invoke": return {
        kind: "invoke" as const,
        withType: t.withType!,
        ...(t.inputExpr != null && { inputExpr: t.inputExpr }),
        ...(resolveMap != null && { resolveMap }),
      };
      case "cron": return {
        kind: "cron" as const,
        cron: t.cronExpr!,
        ...(t.inputExpr != null && { inputExpr: t.inputExpr }),
        ...(resolveMap != null && { resolveMap }),
      };
      case "event": return {
        kind: "event" as const,
        topic: t.topic!,
        withType: t.withType!,
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

export function emitAgentRegistrationIR(agent: AgentDef): AgentRegistrationIR {
  return {
    agentName: agent.name,
    roleName: agent.runs,
    ...(agent.tags != null && { tags: agent.tags }),
    ...(agent.capabilities != null && { capabilities: agent.capabilities }),
    ...(agent.labels != null && { labels: agent.labels }),
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
  readonly participants: Map<string, ParticipantIR>;
  readonly errors: string[];

  states: IRState[] = [];
  transitions: IRTransition[] = [];
  initialStateId: string;
  terminalStateIds: string[] = [];
  private sourceMapEntries: SourceMapEntry[] = [];
  private activeScatterRoles: string[] = [];

  /** The "current" state ID — the last state emitted, where the next transition will start from. */
  private currentId: string;

  constructor(
    protocolName: string,
    role: string,
    lang: LangTag,
    langMap: Map<string, LangTag>,
    participants: Map<string, ParticipantIR>,
    errors: string[],
  ) {
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

  private annotateStateRange(
    startIndex: number,
    meta: {
      scopeId: string;
      phase: "try" | "catch";
      catchStateId: string;
      catchLabel: string;
    },
  ): void {
    for (let idx = startIndex; idx < this.states.length; idx++) {
      this.states[idx].tryScope = meta;
    }
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
    const targetParticipant = this.participants.get(msg.to);

    if (!isSender && !isReceiver) {
      // This role is not involved in this message — skip but maintain control flow continuity
      return;
    }

    const narrowedByScatter = this.activeScatterRoles.includes(msg.to);
    if (isSender && targetParticipant?.cardinality === "many" && !narrowedByScatter) {
      this.errors.push(
        `Protocol "${this.protocolName}": direct send ${msg.from} -> ${msg.to} (${msg.messageName}) is ambiguous because participant "${msg.to}" is declared many. Use scatter or explicit narrowing.`,
      );
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
    this.advance(guardId, {
      kind: "guard",
      guardType: "xor",
      ...(alt.decisionRole ? { decisionRole: alt.decisionRole } : {}),
    });

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
    const scopeId = `try_${tryStmt.loc.start.line}_${tryStmt.loc.start.col}`;
    const tryEntryId = this.currentId;
    const tryStateStart = this.states.length;
    this.emitBody(tryStmt.tryBody);
    const tryExitId = this.currentId;

    // Merge point after try/catch
    const mergeId = nextId("try_merge");

    // Normal path → merge
    this.addTransition(tryExitId, mergeId, { kind: "default" });

    // Error path: any state in the try body can transition to catch on error
    // We model this as: tryEntry has an error edge to catch entry
    const catchEntryId = nextId("catch");
    this.addState(catchEntryId, { kind: "error", label: tryStmt.catchLabel }, tryStmt.loc);
    this.addTransition(tryEntryId, catchEntryId, { kind: "error" });
    this.annotateStateRange(tryStateStart, {
      scopeId,
      phase: "try",
      catchStateId: catchEntryId,
      catchLabel: tryStmt.catchLabel,
    });

    const catchStateStart = this.states.length - 1;
    this.currentId = catchEntryId;
    this.emitBody(tryStmt.catchBody);
    this.annotateStateRange(catchStateStart, {
      scopeId,
      phase: "catch",
      catchStateId: catchEntryId,
      catchLabel: tryStmt.catchLabel,
    });

    // Catch path → merge
    this.addTransition(this.currentId, mergeId, { kind: "default" });

    this.addState(mergeId, { kind: "guard", guardType: "expression" });
    this.currentId = mergeId;
  }

  // ── Invoke (sync and async) ─────────────────────────────────────

  private emitInvoke(stmt: InvokeStmt): void {
    if (stmt.callerRole !== this.role) return;

    if (stmt.async) {
      const id = nextId("async_invoke");
      this.advance(id, {
        kind: "async_invoke",
        protocolName: stmt.protocolName,
        input: stmt.input,
        roleMapping: stmt.roleMapping,
      }, { kind: "default" }, stmt.loc);
    } else {
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

  private emitSpawn(stmt: SpawnStmt): void {
    if (stmt.callerRole !== this.role) return;

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

  private emitScatter(stmt: ScatterStmt): void {
    const itemParticipant = this.participants.get(stmt.itemRole);
    if (!itemParticipant) {
      this.errors.push(`Protocol "${this.protocolName}": scatter target "${stmt.itemRole}" is not a declared participant.`);
      return;
    }
    if (itemParticipant.cardinality !== "many") {
      this.errors.push(
        `Protocol "${this.protocolName}": scatter target "${stmt.itemRole}" must be declared many.`,
      );
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
    const branchStartIds: string[] = [];

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
