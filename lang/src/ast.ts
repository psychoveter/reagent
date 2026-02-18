/**
 * Reagent AST — v0.0.7
 *
 * Typed node hierarchy for the full Reagent protocol language.
 * Every node carries a SourceLocation (Loc) for editor integration.
 */

// ── Source location ──────────────────────────────────────────────────

export type Pos = { index: number; line: number; col: number };
export type Loc = { start: Pos; end: Pos };

// ── Program (top-level) ─────────────────────────────────────────────

export type Program = {
  kind: "Program";
  items: TopLevelItem[];
};

export type TopLevelItem = ImportStmt | ProtocolDef | AgentDef | MessageDef | RoleDef;

// ── Import ──────────────────────────────────────────────────────────

export type ImportStmt = {
  kind: "ImportStmt";
  path: string;
  alias?: string;
  loc: Loc;
};

// ── Protocol definition ─────────────────────────────────────────────

export type ProtocolDef = {
  kind: "ProtocolDef";
  name: string;
  participants: ParticipantDecl[];
  initiator: string;
  input: string;
  body: ProtocolItem[];
  loc: Loc;
};

export type LangTag = "ts" | "js" | "py" | "kt" | "*";

export type ParticipantDecl = {
  kind: "ParticipantDecl";
  name: string;
  lang: LangTag;
  loc: Loc;
};

// ── Protocol body items ─────────────────────────────────────────────

export type ProtocolItem =
  | MessageStmt
  | AgentZone
  | AltStmt
  | LoopStmt
  | ParStmt
  | WaitStmt
  | TryStmt;

// ── Message step ────────────────────────────────────────────────────

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

// ── Agent zone (standalone) ─────────────────────────────────────────

export type AgentZone = {
  kind: "AgentZone";
  agent: string;
  lang: LangTag;
  body: string;
  loc: Loc;
};

// ── Control flow: alt ───────────────────────────────────────────────

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

export type AltGuard =
  | AltMessageGuard
  | AltExprGuard
  | AltTimeoutGuard
  | AltElseGuard;

export type AltMessageGuard = {
  kind: "AltMessageGuard";
  from: string;
  arrow: ArrowKind;
  to: string;
  messageName: string;
  props?: MessageProps;
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

// ── Control flow: loop ──────────────────────────────────────────────

export type LoopStmt = {
  kind: "LoopStmt";
  guard: string;
  body: ProtocolItem[];
  loc: Loc;
};

// ── Control flow: par ───────────────────────────────────────────────

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

// ── Control flow: wait ──────────────────────────────────────────────

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

// ── Control flow: try/catch ─────────────────────────────────────────

export type TryStmt = {
  kind: "TryStmt";
  tryBody: ProtocolItem[];
  catchLabel: string;
  catchBody: ProtocolItem[];
  loc: Loc;
};

// ── Agent definition (deployment binding) ───────────────────────────

export type AgentDef = {
  kind: "AgentDef";
  name: string;
  lang?: LangTag;
  runs: string;
  loc: Loc;
};

export type PlaysDecl = {
  kind: "PlaysDecl";
  protocolName: string;
  roleName: string;
  loc: Loc;
};

// ── Role definition (primary behavioral contract) ───────────────────

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

export type RoleEventKind =
  | "protocolStarted"
  | "protocolCompleted"
  | "protocolFailed"
  | "protocolEvent";

export type RoleOnHandler = {
  kind: "RoleOnHandler";
  event: RoleEventKind;
  protocolFilter?: string;
  body: string;
  loc: Loc;
};

// ── Message definition (typed message payload) ──────────────────────

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

export type TypeExpr =
  | ScalarType
  | ArrayType
  | ObjectType
  | AnyType;

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
