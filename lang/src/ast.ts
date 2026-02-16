export type Pos = { index: number; line: number; col: number };
export type Loc = { start: Pos; end: Pos };

export type Program = { kind: "Program"; items: Item[] };

export type Item = ImportStmt | ProtocolDef;

export type ImportStmt = {
  kind: "ImportStmt";
  path: string;
  alias?: string;
  loc: Loc;
};

export type ProtocolDef = {
  kind: "ProtocolDef";
  name: string;
  participants: string[];
  initiator: string;
  on: MessageSig;
  body: ProtocolItem[];
  loc: Loc;
};

export type MessageSig = {
  from: string;
  to: string;
  name: string;
  loc: Loc;
};

export type ProtocolItem = MessageStmt | AgentZone | RawStmt;

export type MessageStmt = {
  kind: "MessageStmt";
  from: string;
  to: string;
  name: string;
  props: ObjectValue;
  loc: Loc;
};

export type AgentZone = {
  kind: "AgentZone";
  agent: string;
  body: string;
  loc: Loc;
};

/**
 * Placeholder node for constructs not yet formalized (alt/loop/par/spawn/try/wait/invoke...).
 * We keep the raw text + loc so editor tooling can still operate while semantics evolve.
 */
export type RawStmt = {
  kind: "RawStmt";
  text: string;
  loc: Loc;
};

export type Value =
  | NullValue
  | BoolValue
  | NumberValue
  | StringValue
  | IdentValue
  | ObjectValue
  | ArrayValue;

export type NullValue = { type: "null"; loc: Loc };
export type BoolValue = { type: "bool"; value: boolean; loc: Loc };
export type NumberValue = { type: "number"; value: number; loc: Loc };
export type StringValue = { type: "string"; value: string; loc: Loc };
export type IdentValue = { type: "ident"; name: string; loc: Loc };

export type ObjectEntry = { key: string; value: Value; loc: Loc };
export type ObjectValue = { type: "object"; entries: ObjectEntry[]; loc: Loc };

export type ArrayValue = { type: "array"; items: Value[]; loc: Loc };

