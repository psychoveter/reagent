/**
 * Reagent AST — v0.0.14
 *
 * Typed node hierarchy for the full Reagent protocol language.
 * Every node carries a SourceLocation (Loc) for editor integration.
 */
export type Pos = {
    index: number;
    line: number;
    col: number;
};
export type Loc = {
    start: Pos;
    end: Pos;
};
export type Program = {
    kind: "Program";
    items: TopLevelItem[];
};
export type TopLevelItem = ImportStmt | ProtocolDef | AgentDef | MessageDef | RoleDef;
export type ImportStmt = {
    kind: "ImportStmt";
    path: string;
    alias?: string;
    loc: Loc;
};
export type ProtocolDef = {
    kind: "ProtocolDef";
    name: string;
    participants: ParticipantDecl[];
    triggers: TriggerDecl[];
    body: ProtocolItem[];
    loc: Loc;
};
export type TriggerKind = "invoke" | "cron" | "event";
export type TriggerDecl = {
    kind: "TriggerDecl";
    triggerKind: TriggerKind;
    /** Input type name after `with` keyword. Required for invoke/event; absent for cron (system CronTrigger). */
    withType?: string;
    /** Cron expression (for cron triggers) */
    cronExpr?: string;
    /** Event topic name (for event triggers) */
    topic?: string;
    /** Optional post-processing expression (RHS of `$ctx.input = <expr>`). Absent = use raw trigger data. */
    inputExpr?: string;
    /** Resolve declarations: `resolve role = pipeline` */
    resolveDecls?: ResolveDecl[];
    loc: Loc;
};
export type ResolveDecl = {
    kind: "ResolveDecl";
    role: string;
    pipeline: ResolvePipelineStep[];
    loc: Loc;
};
export type ResolvePipelineStep = {
    step: "all";
} | {
    step: "single";
} | {
    step: "from";
    expr: string;
} | {
    step: "filter";
    predicate: string;
} | {
    step: "roundRobin";
} | {
    step: "leastLoaded";
} | {
    step: "random";
} | {
    step: "sample";
    count: number;
} | {
    step: "first";
} | {
    step: "fallback";
    chain: ResolvePipelineStep[];
} | {
    step: "custom";
    name: string;
};
export type LangTag = "ts" | "js" | "py" | "kt" | "*";
export type ParticipantBinding = "static" | "dynamic";
export type ParticipantCardinality = "single" | "many";
export type ParticipantDecl = {
    kind: "ParticipantDecl";
    name: string;
    lang: LangTag;
    binding?: ParticipantBinding;
    cardinality?: ParticipantCardinality;
    initiator?: boolean;
    loc: Loc;
};
export type ProtocolItem = MessageStmt | AgentZone | AltStmt | LoopStmt | ParStmt | WaitStmt | TryStmt | InvokeStmt | SpawnStmt | ScatterStmt;
export type ArrowKind = "-->" | "->" | "->>" | "-->>";
export type MessageStmt = {
    kind: "MessageStmt";
    from: string;
    arrow: ArrowKind;
    to: string;
    messageName: string;
    props?: MessageProps;
    loc: Loc;
};
/**
 * Message props block: `= { ... }`.
 * Contains hook zones (onSend/onReceive) and/or key-value pairs (for alt guard patterns).
 */
export type MessageProps = {
    kind: "MessageProps";
    hooks: HookZone[];
    pairs: PropPair[];
    loc: Loc;
};
export type HookZone = {
    kind: "HookZone";
    hookType: "onSend" | "onReceive";
    body: string;
    loc: Loc;
};
export type PropPair = {
    kind: "PropPair";
    key: string;
    value: string;
    loc: Loc;
};
export type AgentZone = {
    kind: "AgentZone";
    agent: string;
    lang: LangTag;
    body: string;
    loc: Loc;
};
export type AltStmt = {
    kind: "AltStmt";
    branches: AltBranch[];
    loc: Loc;
};
export type AltBranch = {
    kind: "AltBranch";
    guard: AltGuard;
    body: ProtocolItem[];
    loc: Loc;
};
export type AltGuard = AltMessageGuard | AltExprGuard | AltTimeoutGuard | AltElseGuard;
export type AltMessageGuard = {
    kind: "AltMessageGuard";
    from: string;
    arrow: ArrowKind;
    to: string;
    messageName: string;
    props?: MessageProps;
    /** Pattern clause from `where { ... }` syntax (v0.0.8+) */
    whereClause?: Record<string, string>;
    loc: Loc;
};
export type AltExprGuard = {
    kind: "AltExprGuard";
    expr: string;
    loc: Loc;
};
export type AltTimeoutGuard = {
    kind: "AltTimeoutGuard";
    duration: Duration;
    loc: Loc;
};
export type AltElseGuard = {
    kind: "AltElseGuard";
    loc: Loc;
};
export type LoopStmt = {
    kind: "LoopStmt";
    guard: string;
    body: ProtocolItem[];
    loc: Loc;
};
export type ParStmt = {
    kind: "ParStmt";
    branches: ParBranch[];
    loc: Loc;
};
export type ParBranch = {
    kind: "ParBranch";
    body: ProtocolItem[];
    loc: Loc;
};
export type WaitStmt = {
    kind: "WaitStmt";
    duration: Duration;
    loc: Loc;
};
export type DurationUnit = "ms" | "s" | "m" | "h";
export type Duration = {
    value: number;
    unit: DurationUnit;
    loc: Loc;
};
export type TryStmt = {
    kind: "TryStmt";
    tryBody: ProtocolItem[];
    catchLabel: string;
    catchBody: ProtocolItem[];
    loc: Loc;
};
export type InvokeStmt = {
    kind: "InvokeStmt";
    async?: boolean;
    protocolName: string;
    input: string;
    callerRole: string;
    roleMapping?: Record<string, string>;
    resultTarget?: string;
    loc: Loc;
};
export type SpawnStmt = {
    kind: "SpawnStmt";
    callerRole: string;
    roleName: string;
    config: string;
    bindAs?: string;
    resultTarget?: string;
    persistent?: boolean;
    loc: Loc;
};
export type ScatterStmt = {
    kind: "ScatterStmt";
    collection: string;
    itemRole: string;
    body: ProtocolItem[];
    loc: Loc;
};
export type AgentDef = {
    kind: "AgentDef";
    name: string;
    lang?: LangTag;
    runs: string;
    tags?: string[];
    capabilities?: string[];
    labels?: Record<string, string>;
    loc: Loc;
};
export type PlaysDecl = {
    kind: "PlaysDecl";
    protocolName: string;
    roleName: string;
    loc: Loc;
};
export type RoleDef = {
    kind: "RoleDef";
    name: string;
    lang?: LangTag;
    extends?: string;
    plays: PlaysDecl[];
    init?: RoleInitBlock;
    handlers: RoleOnHandler[];
    loc: Loc;
};
export type RoleInitBlock = {
    kind: "RoleInitBlock";
    body: string;
    loc: Loc;
};
export type RoleEventKind = "protocolStarted" | "protocolCompleted" | "protocolFailed" | "protocolEvent";
export type RoleOnHandler = {
    kind: "RoleOnHandler";
    event: RoleEventKind;
    protocolFilter?: string;
    body: string;
    loc: Loc;
};
export type MessageDef = {
    kind: "MessageDef";
    name: string;
    fields: FieldDef[];
    loc: Loc;
};
export type FieldDef = {
    kind: "FieldDef";
    name: string;
    type: TypeExpr;
    optional: boolean;
    loc: Loc;
};
export type TypeExpr = ScalarType | ArrayType | ObjectType | AnyType;
export type ScalarType = {
    kind: "ScalarType";
    name: "string" | "number" | "boolean";
};
export type ArrayType = {
    kind: "ArrayType";
    element: TypeExpr;
};
export type ObjectType = {
    kind: "ObjectType";
    fields: FieldDef[];
};
export type AnyType = {
    kind: "AnyType";
};
