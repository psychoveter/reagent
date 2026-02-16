## Reagent language spec (prototype, v0)

This document defines the **Reagent protocol language** (not Mermaid).

Design goals:
- Human-writable, line-oriented.
- Extensible “props-like” dictionaries on steps (for compiler/runtime hooks).
- Supports **agent functional zones**: `AgentName { ... }` as executable/code regions.
- Produces a well-defined **AST** with source locations, suitable for Cursor plugins.

Non-goals (v0):
- Full typechecking of embedded code.
- Full parsing of arbitrary programming languages inside agent zones (zones are stored as raw text).

Status note:
- The language is being designed **from examples first**. See `projects/reagent/examples/`.
- The current parser is a prototype and will likely be replaced by a grammar-based approach (e.g. tree-sitter) once syntax stabilizes.
- Cursor/VSCode syntax highlighting lives in `projects/reagent/tools/reagent-vscode/` (TextMate grammar).

---

## 1) Concrete syntax (informal)

### 1.1 Message step

A message is written as:

```
A --> B: MessageName = { ...props... }
```

Where:
- `A` and `B` are **role/agent identifiers**.
- `MessageName` is an identifier-like name (kept as raw text until `=`).
- `= { ... }` is a dict (object literal) used for extensible semantics.

#### Protocol input (unknown sender) and event emission

Reagent treats a `protocol` as a **function**.

It has an **input message type** declared in the protocol header:

```
protocol P {
  participants: ...
  initiator: X
  input: SomeMessage
  ...
}
```

Semantics:
- The protocol starts when the engine delivers an **external** input message of type `SomeMessage` to the **initiator** `X`.
- The sender of the input is unknown / out-of-scope; it is not represented as a role.

Emitting events outward is modeled as a reserved statement (examples-first):

```
emit SomeEvent = { ... }
```

### 1.2 Agent functional zone

An agent zone is written as:

```
AgentName {
  // agent-local code block (raw text)
}
```

Zone body is stored as raw text; braces may be nested and are balanced by the parser.

### 1.3 Control flow and other communicative acts (reserved syntax; examples drive final form)

We need protocol-level constructs beyond message lines:
- `alt` (XOR branching)
- `loop` (repetition)
- `par` (parallel branches + join)
- `wait` (time delay)
- `timeout` (guard timeout)
- `spawn` (subagent / subprotocol creation)
- `try/catch` (abort/compensation)
- `return` (return a value from protocol to invoker)

These are currently specified by **examples** and will be formalized once a minimal corpus stabilizes.

---

## 2) BNF / EBNF (v0)

Notation: this is EBNF; `*` means repetition, `?` means optional.

```
Program         ::= (WS | Comment | ImportStmt | ProtocolDef)* EOF

ImportStmt      ::= "import" WS+ String (WS+ "as" WS+ Ident)? WS* (";" WS*)?     // newline allowed as WS

ProtocolDef     ::= "protocol" WS+ Ident WS* "{" ProtocolBody "}"
ProtocolBody    ::= (WS | Comment | ProtocolDirective | Item | ReservedStmt)*    // until matching "}"

ProtocolDirective ::= ParticipantsStmt | InitiatorStmt | InputStmt
ParticipantsStmt  ::= "participants" WS* ":" WS* IdentList
IdentList         ::= Ident (WS* "," WS* Ident)*
InitiatorStmt     ::= "initiator" WS* ":" WS* Ident
InputStmt         ::= "input" WS* ":" WS* Ident

Item            ::= MessageStmt | AgentZone

MessageStmt     ::= Ident WS* Arrow WS* Ident WS* ":" WS* MessageName WS* "=" WS* Object

Arrow           ::= "-->" | "->" | "->>" | "-->>"

MessageName     ::= MessageNameChar+          // trimmed; stops before '='
MessageNameChar ::= any char except '\n' and '='

AgentZone       ::= Ident WS* "{" ZoneBody "}"
ZoneBody        ::= BalancedText              // raw; braces are balanced, strings/comments skipped

// ReservedStmt are syntactic placeholders used by examples to drive design.
// They will be specified once the example corpus stabilizes.
ReservedStmt    ::= AltStmt | LoopStmt | ParStmt | WaitStmt | SpawnStmt | TryStmt | InvokeStmt | ReturnStmt
AltStmt         ::= "alt" .*                   // placeholder
LoopStmt        ::= "loop" .*                  // placeholder
ParStmt         ::= "par" .*                   // placeholder
WaitStmt        ::= "wait" .*                  // placeholder
SpawnStmt       ::= "spawn" .*                 // placeholder
TryStmt         ::= "try" .*                   // placeholder
InvokeStmt      ::= "invoke" .*                // placeholder
ReturnStmt      ::= "return" .*                // placeholder

Object          ::= "{" WS* (Pair (WS* "," WS* Pair)*)? WS* "}"
Pair            ::= Key WS* ":" WS* Value
Key             ::= Ident | String

Value           ::= Null | Bool | Number | String | Ident | Object | Array
Array           ::= "[" WS* (Value (WS* "," WS* Value)*)? WS* "]"

Ident           ::= IdentStart IdentPart*
IdentStart      ::= [A-Za-z_]                 // ASCII for v0 (can be widened later)
IdentPart       ::= [A-Za-z0-9_\\-\\.]         // allows dot for names like comma.onAck

String          ::= DQString | SQString
DQString        ::= '\"' ( [^\"\\\\] | Escape )* '\"'
SQString        ::= \"'\" ( [^'\\\\] | Escape )* \"'\"
Escape          ::= \"\\\\\" (\"\\\\\" | '\"' | \"'\" | \"n\" | \"r\" | \"t\")

Number          ::= '-'? ([0-9]+) ('.' [0-9]+)?
Bool            ::= "true" | "false"
Null            ::= "null"

Comment         ::= LineComment | BlockComment
LineComment     ::= "//" [^\\n]* "\\n"?
BlockComment    ::= "/*" .* "*/"              // non-nested

WS              ::= (" " | "\\t" | "\\r" | "\\n")+
```

---

## 3) Example: task execution protocol (user → comma → sia)

See `projects/reagent/examples/01-task-execution-basic.rg`.

---

## 4) AST JSON Schema (v0)

The parser MUST output an AST conforming to the schema below.
The same schema is also stored as a file at `lang/ast.schema.json`.

**Important:** the current AST schema and hand-written parser only cover `MessageStmt` and `AgentZone`.
`protocol` / `import` / `invoke` / control-flow constructs are being added **via examples first** and will be formalized into AST in the next iteration.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://psychoveter.github.io/reagent/schemas/lang/ast.v0.json",
  "title": "Reagent Language AST (v0)",
  "type": "object",
  "required": ["kind", "items"],
  "properties": {
    "kind": { "const": "Program" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/Item" }
    }
  },
  "$defs": {
    "Loc": {
      "type": "object",
      "required": ["start", "end"],
      "properties": {
        "start": { "$ref": "#/$defs/Pos" },
        "end": { "$ref": "#/$defs/Pos" }
      },
      "additionalProperties": false
    },
    "Pos": {
      "type": "object",
      "required": ["index", "line", "col"],
      "properties": {
        "index": { "type": "integer", "minimum": 0 },
        "line": { "type": "integer", "minimum": 1 },
        "col": { "type": "integer", "minimum": 1 }
      },
      "additionalProperties": false
    },
    "Item": {
      "oneOf": [
        { "$ref": "#/$defs/MessageStmt" },
        { "$ref": "#/$defs/AgentZone" }
      ]
    },
    "MessageStmt": {
      "type": "object",
      "required": ["kind", "from", "to", "name", "props", "loc"],
      "properties": {
        "kind": { "const": "MessageStmt" },
        "from": { "type": "string", "minLength": 1 },
        "to": { "type": "string", "minLength": 1 },
        "name": { "type": "string", "minLength": 1 },
        "props": { "$ref": "#/$defs/ObjectValue" },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "AgentZone": {
      "type": "object",
      "required": ["kind", "agent", "body", "loc"],
      "properties": {
        "kind": { "const": "AgentZone" },
        "agent": { "type": "string", "minLength": 1 },
        "body": { "type": "string" },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "Value": {
      "oneOf": [
        { "$ref": "#/$defs/NullValue" },
        { "$ref": "#/$defs/BoolValue" },
        { "$ref": "#/$defs/NumberValue" },
        { "$ref": "#/$defs/StringValue" },
        { "$ref": "#/$defs/IdentValue" },
        { "$ref": "#/$defs/ObjectValue" },
        { "$ref": "#/$defs/ArrayValue" }
      ]
    },
    "NullValue": {
      "type": "object",
      "required": ["type", "loc"],
      "properties": {
        "type": { "const": "null" },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "BoolValue": {
      "type": "object",
      "required": ["type", "value", "loc"],
      "properties": {
        "type": { "const": "bool" },
        "value": { "type": "boolean" },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "NumberValue": {
      "type": "object",
      "required": ["type", "value", "loc"],
      "properties": {
        "type": { "const": "number" },
        "value": { "type": "number" },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "StringValue": {
      "type": "object",
      "required": ["type", "value", "loc"],
      "properties": {
        "type": { "const": "string" },
        "value": { "type": "string" },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "IdentValue": {
      "type": "object",
      "required": ["type", "name", "loc"],
      "properties": {
        "type": { "const": "ident" },
        "name": { "type": "string", "minLength": 1 },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "ObjectValue": {
      "type": "object",
      "required": ["type", "entries", "loc"],
      "properties": {
        "type": { "const": "object" },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["key", "value", "loc"],
            "properties": {
              "key": { "type": "string" },
              "value": { "$ref": "#/$defs/Value" },
              "loc": { "$ref": "#/$defs/Loc" }
            },
            "additionalProperties": false
          }
        },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    },
    "ArrayValue": {
      "type": "object",
      "required": ["type", "items", "loc"],
      "properties": {
        "type": { "const": "array" },
        "items": {
          "type": "array",
          "items": { "$ref": "#/$defs/Value" }
        },
        "loc": { "$ref": "#/$defs/Loc" }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

