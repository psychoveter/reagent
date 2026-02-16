import type {
  AgentZone,
  ArrayValue,
  BoolValue,
  ImportStmt,
  IdentValue,
  Loc,
  MessageStmt,
  MessageSig,
  NullValue,
  NumberValue,
  ObjectEntry,
  ObjectValue,
  Pos,
  Program,
  ProtocolDef,
  ProtocolItem,
  RawStmt,
  StringValue,
  Value,
} from "./ast.js";
import type { Item } from "./ast.js";

export type ParseError = {
  message: string;
  loc: Loc;
};

export type ParseResult =
  | { ok: true; ast: Program }
  | { ok: false; error: ParseError };

class Cursor {
  readonly src: string;
  i = 0;
  line = 1;
  col = 1;

  constructor(src: string) {
    this.src = src;
  }

  eof(): boolean {
    return this.i >= this.src.length;
  }

  pos(): Pos {
    return { index: this.i, line: this.line, col: this.col };
  }

  locFrom(start: Pos): Loc {
    return { start, end: this.pos() };
  }

  peek(n = 0): string {
    return this.src[this.i + n] ?? "";
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  next(): string {
    const ch = this.peek();
    if (!ch) return "";
    this.i += 1;
    if (ch === "\n") {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return ch;
  }

  error(message: string, start: Pos): ParseResult {
    return { ok: false, error: { message, loc: this.locFrom(start) } };
  }
}

function isWS(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_\-\.]/.test(ch);
}

function skipWSAndComments(c: Cursor): void {
  for (;;) {
    // whitespace
    while (!c.eof() && isWS(c.peek())) c.next();

    // line comment //
    if (c.startsWith("//")) {
      while (!c.eof() && c.peek() !== "\n") c.next();
      continue;
    }

    // block comment /* ... */
    if (c.startsWith("/*")) {
      c.next();
      c.next();
      while (!c.eof() && !c.startsWith("*/")) c.next();
      if (c.startsWith("*/")) {
        c.next();
        c.next();
      }
      continue;
    }

    break;
  }
}

function isKeywordBoundary(ch: string): boolean {
  return ch === "" || !isIdentPart(ch);
}

function startsWithKeyword(c: Cursor, kw: string): boolean {
  if (!c.startsWith(kw)) return false;
  return isKeywordBoundary(c.peek(kw.length));
}

function readIdent(c: Cursor): { name: string; loc: Loc } | null {
  const start = c.pos();
  const ch = c.peek();
  if (!isIdentStart(ch)) return null;
  let s = "";
  s += c.next();
  while (!c.eof() && isIdentPart(c.peek())) s += c.next();
  return { name: s, loc: c.locFrom(start) };
}

function readKeyword(c: Cursor, kw: string): { loc: Loc } | ParseResult {
  const start = c.pos();
  if (!startsWithKeyword(c, kw)) return c.error(`Expected keyword '${kw}'`, start);
  for (let k = 0; k < kw.length; k++) c.next();
  return { loc: c.locFrom(start) };
}

function expect(c: Cursor, s: string, what: string): ParseResult | null {
  const start = c.pos();
  if (!c.startsWith(s)) return c.error(`Expected ${what}`, start);
  for (let k = 0; k < s.length; k++) c.next();
  return null;
}

function readString(c: Cursor): { value: string; loc: Loc } | ParseResult {
  const start = c.pos();
  const q = c.peek();
  if (q !== `"` && q !== `'`) return c.error("Expected string", start);
  c.next(); // open quote
  let out = "";
  while (!c.eof()) {
    const ch = c.next();
    if (ch === q) return { value: out, loc: c.locFrom(start) };
    if (ch === "\\") {
      const esc = c.next();
      if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === `"` || esc === `'` || esc === "\\") out += esc;
      else out += esc; // permissive
      continue;
    }
    out += ch;
  }
  return c.error("Unterminated string", start);
}

function readNumber(c: Cursor): { value: number; loc: Loc } | null {
  const start = c.pos();
  let s = "";
  if (c.peek() === "-") s += c.next();
  if (!/[0-9]/.test(c.peek())) return null;
  while (/[0-9]/.test(c.peek())) s += c.next();
  if (c.peek() === ".") {
    s += c.next();
    while (/[0-9]/.test(c.peek())) s += c.next();
  }
  return { value: Number(s), loc: c.locFrom(start) };
}

function parseValue(c: Cursor): Value | ParseResult {
  skipWSAndComments(c);
  const start = c.pos();

  // null/true/false
  if (c.startsWith("null")) {
    for (let k = 0; k < 4; k++) c.next();
    const v: NullValue = { type: "null", loc: c.locFrom(start) };
    return v;
  }
  if (c.startsWith("true")) {
    for (let k = 0; k < 4; k++) c.next();
    const v: BoolValue = { type: "bool", value: true, loc: c.locFrom(start) };
    return v;
  }
  if (c.startsWith("false")) {
    for (let k = 0; k < 5; k++) c.next();
    const v: BoolValue = { type: "bool", value: false, loc: c.locFrom(start) };
    return v;
  }

  // object
  if (c.peek() === "{") return parseObject(c);

  // array
  if (c.peek() === "[") return parseArray(c);

  // string
  if (c.peek() === `"` || c.peek() === `'`) {
    const s = readString(c);
    if ("ok" in s) return s;
    const v: StringValue = { type: "string", value: s.value, loc: s.loc };
    return v;
  }

  // number
  const n = readNumber(c);
  if (n) {
    const v: NumberValue = { type: "number", value: n.value, loc: n.loc };
    return v;
  }

  // ident-as-value
  const id = readIdent(c);
  if (id) {
    const v: IdentValue = { type: "ident", name: id.name, loc: id.loc };
    return v;
  }

  return c.error("Expected value", start);
}

function parseObject(c: Cursor): ObjectValue | ParseResult {
  const start = c.pos();
  const e0 = expect(c, "{", "'{'");
  if (e0) return e0;
  skipWSAndComments(c);

  const entries: ObjectEntry[] = [];
  if (c.peek() !== "}") {
    for (;;) {
      skipWSAndComments(c);
      const entryStart = c.pos();

      // key: ident or string
      let key: string | null = null;
      if (isIdentStart(c.peek())) {
        const id = readIdent(c);
        key = id?.name ?? null;
      } else if (c.peek() === `"` || c.peek() === `'`) {
        const s = readString(c);
        if ("ok" in s) return s;
        key = s.value;
      }
      if (key == null) return c.error("Expected object key", entryStart);

      skipWSAndComments(c);
      const e1 = expect(c, ":", "':'");
      if (e1) return e1;

      const value = parseValue(c);
      if ("ok" in value) return value;

      const entry: ObjectEntry = {
        key,
        value,
        loc: { start: entryStart, end: value.loc.end },
      };
      entries.push(entry);

      skipWSAndComments(c);
      if (c.peek() === ",") {
        c.next();
        continue;
      }
      break;
    }
  }

  skipWSAndComments(c);
  const e2 = expect(c, "}", "'}'");
  if (e2) return e2;
  const obj: ObjectValue = { type: "object", entries, loc: c.locFrom(start) };
  return obj;
}

function parseArray(c: Cursor): ArrayValue | ParseResult {
  const start = c.pos();
  const e0 = expect(c, "[", "'['");
  if (e0) return e0;
  skipWSAndComments(c);

  const items: Value[] = [];
  if (c.peek() !== "]") {
    for (;;) {
      const v = parseValue(c);
      if ("ok" in v) return v;
      items.push(v);
      skipWSAndComments(c);
      if (c.peek() === ",") {
        c.next();
        continue;
      }
      break;
    }
  }

  skipWSAndComments(c);
  const e1 = expect(c, "]", "']'");
  if (e1) return e1;
  return { type: "array", items, loc: c.locFrom(start) };
}

function readUntilEOL(c: Cursor): string {
  let s = "";
  while (!c.eof() && c.peek() !== "\n") s += c.next();
  return s;
}

function readArrow(c: Cursor): string | null {
  const arrows = ["-->>", "->>", "-->", "->"] as const;
  const arrow = arrows.find((a) => c.startsWith(a));
  if (!arrow) return null;
  for (let k = 0; k < arrow.length; k++) c.next();
  return arrow;
}

function parseMessageSig(c: Cursor): MessageSig | ParseResult {
  const start = c.pos();
  skipWSAndComments(c);
  const from = readIdent(c);
  if (!from) return c.error("Expected sender identifier", start);
  skipWSAndComments(c);
  const arrowStart = c.pos();
  const arrow = readArrow(c);
  if (!arrow) return c.error("Expected arrow in message signature", arrowStart);
  skipWSAndComments(c);
  const to = readIdent(c);
  if (!to) return c.error("Expected receiver identifier", c.pos());
  skipWSAndComments(c);
  const e0 = expect(c, ":", "':'");
  if (e0) return e0;
  skipWSAndComments(c);
  const name = readIdent(c);
  if (!name) return c.error("Expected message name in signature", c.pos());
  return {
    from: from.name,
    to: to.name,
    name: name.name,
    loc: c.locFrom(start),
  };
}

function parseMessageStmt(c: Cursor, from: string, fromLoc: Loc): MessageStmt | ParseResult {
  const start = fromLoc.start;

  skipWSAndComments(c);

  // arrow
  const arrowStart = c.pos();
  const arrow = readArrow(c);
  if (!arrow) return c.error("Expected arrow (-->, ->, ->>, -->>)", arrowStart);

  skipWSAndComments(c);
  const to = readIdent(c);
  if (!to) return c.error("Expected receiver identifier", c.pos());

  skipWSAndComments(c);
  const e0 = expect(c, ":", "':'");
  if (e0) return e0;

  // message name: read until '=' (can span spaces, but stays before object)
  skipWSAndComments(c);
  const nameStart = c.pos();
  let nameRaw = "";
  while (!c.eof()) {
    const ch = c.peek();
    if (ch === "\n") break;
    if (ch === "=") break;
    nameRaw += c.next();
  }
  const name = nameRaw.trim();
  if (!name) return c.error("Expected message name before '='", nameStart);

  skipWSAndComments(c);
  const eEq = expect(c, "=", "'='");
  if (eEq) return eEq;

  // props object (may be multi-line; WS includes newlines)
  skipWSAndComments(c);
  const props = parseObject(c);
  if ("ok" in props) return props;

  // optional trailing whitespace/comments until end-of-line
  skipWSAndComments(c);
  if (c.peek() === "\n") c.next();

  return {
    kind: "MessageStmt",
    from,
    to: to.name,
    name,
    props,
    loc: { start, end: c.pos() },
  };
}

function parseAgentZone(c: Cursor, agent: string, agentLoc: Loc): AgentZone | ParseResult {
  const start = agentLoc.start;
  skipWSAndComments(c);
  const e0 = expect(c, "{", "'{'");
  if (e0) return e0;

  const bodyStart = c.pos();

  // Balanced-brace raw capture with basic string/comment skipping.
  let depth = 1;
  let body = "";

  let inStr: '"' | "'" | null = null;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (!c.eof() && depth > 0) {
    const ch = c.next();

    // comment modes
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      if (depth > 0) body += ch;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && c.peek() === "/") {
        body += ch;
        body += c.next();
        inBlockComment = false;
        continue;
      }
      body += ch;
      continue;
    }

    // string mode
    if (inStr) {
      body += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
      }
      continue;
    }

    // detect start of comments
    if (ch === "/" && c.peek() === "/") {
      body += ch;
      body += c.next();
      inLineComment = true;
      continue;
    }
    if (ch === "/" && c.peek() === "*") {
      body += ch;
      body += c.next();
      inBlockComment = true;
      continue;
    }

    // detect start of strings
    if (ch === `"` || ch === `'`) {
      inStr = ch;
      body += ch;
      continue;
    }

    // braces
    if (ch === "{") {
      depth += 1;
      body += ch;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break; // do not include final closing brace
      body += ch;
      continue;
    }

    body += ch;
  }

  if (depth !== 0) return c.error("Unterminated agent zone (missing '}')", bodyStart);

  return {
    kind: "AgentZone",
    agent,
    body,
    loc: { start, end: c.pos() },
  };
}

function parseImportStmt(c: Cursor): ImportStmt | ParseResult {
  const start = c.pos();
  const kw = readKeyword(c, "import");
  if ("ok" in kw) return kw;
  skipWSAndComments(c);
  const p = readString(c);
  if ("ok" in p) return p;
  skipWSAndComments(c);
  let alias: string | undefined;
  if (startsWithKeyword(c, "as")) {
    readKeyword(c, "as");
    skipWSAndComments(c);
    const a = readIdent(c);
    if (!a) return c.error("Expected import alias identifier", c.pos());
    alias = a.name;
  }
  // optional trailing ';'
  skipWSAndComments(c);
  if (c.peek() === ";") c.next();
  // optional newline
  if (c.peek() === "\n") c.next();
  return { kind: "ImportStmt", path: p.value, alias, loc: c.locFrom(start) };
}

const RESERVED_HEAD_KEYWORDS = ["alt", "loop", "par", "wait", "spawn", "try", "invoke", "break", "throw", "catch", "else", "and"];

function peekNextKeyword(c: Cursor): string | null {
  const saved = c.pos();
  const savedI = c.i;
  const savedLine = c.line;
  const savedCol = c.col;
  skipWSAndComments(c);
  const id = readIdent(c);
  // restore
  c.i = savedI;
  c.line = savedLine;
  c.col = savedCol;
  return id?.name ?? null;
}

function parseRawStmt(c: Cursor): RawStmt {
  const start = c.pos();

  let depth = 0;
  let text = "";

  let inStr: '"' | "'" | null = null;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  // capture until: depth==0 and we are at newline AND next token is not a continuation keyword
  for (;;) {
    if (c.eof()) break;
    const ch = c.next();

    // comment modes
    if (inLineComment) {
      text += ch;
      if (ch === "\n") inLineComment = false;
      if (depth === 0 && ch === "\n") break;
      continue;
    }
    if (inBlockComment) {
      text += ch;
      if (ch === "*" && c.peek() === "/") {
        text += c.next();
        inBlockComment = false;
      }
      continue;
    }

    // string mode
    if (inStr) {
      text += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }

    // detect start of comments
    if (ch === "/" && c.peek() === "/") {
      text += ch;
      text += c.next();
      inLineComment = true;
      continue;
    }
    if (ch === "/" && c.peek() === "*") {
      text += ch;
      text += c.next();
      inBlockComment = true;
      continue;
    }

    // detect strings
    if (ch === `"` || ch === `'`) {
      inStr = ch;
      text += ch;
      continue;
    }

    // braces
    if (ch === "{") {
      depth += 1;
      text += ch;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      text += ch;
      // if we just closed the last brace, we might still need to capture `else/and/catch` continuations
      continue;
    }

    text += ch;

    if (depth === 0 && ch === "\n") {
      const nextKw = peekNextKeyword(c);
      if (nextKw && ["else", "and", "catch"].includes(nextKw)) {
        continue;
      }
      break;
    }
  }

  return { kind: "RawStmt", text, loc: c.locFrom(start) };
}

function parseProtocolItem(c: Cursor): ProtocolItem | ParseResult | null {
  skipWSAndComments(c);
  if (c.eof()) return null;
  if (c.peek() === "}") return null;

  // directives are handled by protocol parser, so here we parse body statements.
  const nextKw = peekNextKeyword(c);
  if (nextKw && RESERVED_HEAD_KEYWORDS.includes(nextKw)) {
    return parseRawStmt(c);
  }

  const id = readIdent(c);
  if (!id) return c.error("Expected identifier in protocol body", c.pos());
  const agentOrFrom = id.name;
  const agentOrFromLoc = id.loc;

  skipWSAndComments(c);
  if (c.peek() === "{") {
    return parseAgentZone(c, agentOrFrom, agentOrFromLoc);
  }
  return parseMessageStmt(c, agentOrFrom, agentOrFromLoc);
}

function parseIdentList(c: Cursor): string[] | ParseResult {
  skipWSAndComments(c);
  const first = readIdent(c);
  if (!first) return c.error("Expected identifier", c.pos());
  const out: string[] = [first.name];
  for (;;) {
    skipWSAndComments(c);
    if (c.peek() !== ",") break;
    c.next();
    skipWSAndComments(c);
    const n = readIdent(c);
    if (!n) return c.error("Expected identifier after ','", c.pos());
    out.push(n.name);
  }
  // optional newline
  if (c.peek() === "\n") c.next();
  return out;
}

function parseProtocolDef(c: Cursor): ProtocolDef | ParseResult {
  const start = c.pos();
  const kw = readKeyword(c, "protocol");
  if ("ok" in kw) return kw;
  skipWSAndComments(c);
  const name = readIdent(c);
  if (!name) return c.error("Expected protocol name", c.pos());
  skipWSAndComments(c);
  const e0 = expect(c, "{", "'{'");
  if (e0) return e0;

  let participants: string[] | null = null;
  let initiator: string | null = null;
  let on: MessageSig | null = null;
  const body: ProtocolItem[] = [];

  for (;;) {
    skipWSAndComments(c);
    if (c.eof()) return c.error("Unterminated protocol block (missing '}')", start);
    if (c.peek() === "}") {
      c.next();
      // optional newline
      if (c.peek() === "\n") c.next();
      break;
    }

    // directives
    if (startsWithKeyword(c, "participants")) {
      readKeyword(c, "participants");
      skipWSAndComments(c);
      const e = expect(c, ":", "':'");
      if (e) return e;
      const list = parseIdentList(c);
      if ("ok" in list) return list;
      participants = list;
      continue;
    }
    if (startsWithKeyword(c, "initiator")) {
      readKeyword(c, "initiator");
      skipWSAndComments(c);
      const e = expect(c, ":", "':'");
      if (e) return e;
      skipWSAndComments(c);
      const id = readIdent(c);
      if (!id) return c.error("Expected initiator identifier", c.pos());
      initiator = id.name;
      if (c.peek() === "\n") c.next();
      continue;
    }
    if (startsWithKeyword(c, "on")) {
      readKeyword(c, "on");
      skipWSAndComments(c);
      const e = expect(c, ":", "':'");
      if (e) return e;
      const sig = parseMessageSig(c);
      if ("ok" in sig) return sig;
      on = sig;
      if (c.peek() === "\n") c.next();
      continue;
    }

    // body statements
    const it = parseProtocolItem(c);
    if (it == null) continue;
    if ("ok" in it) return it;
    body.push(it);
  }

  if (!participants) return c.error("Missing 'participants:' directive in protocol", start);
  if (!initiator) return c.error("Missing 'initiator:' directive in protocol", start);
  if (!on) return c.error("Missing 'on:' directive in protocol", start);

  return {
    kind: "ProtocolDef",
    name: name.name,
    participants,
    initiator,
    on,
    body,
    loc: c.locFrom(start),
  };
}

export function parseProgram(src: string): ParseResult {
  const c = new Cursor(src);
  const items: Item[] = [];

  for (;;) {
    skipWSAndComments(c);
    if (c.eof()) break;
    if (startsWithKeyword(c, "import")) {
      const imp = parseImportStmt(c);
      if ("ok" in imp) return imp;
      items.push(imp);
      continue;
    }
    if (startsWithKeyword(c, "protocol")) {
      const p = parseProtocolDef(c);
      if ("ok" in p) return p;
      items.push(p);
      continue;
    }
    // Enforce: no protocol code outside protocol blocks.
    return c.error("Only 'import' and 'protocol' are allowed at top-level", c.pos());
  }

  return { ok: true, ast: { kind: "Program", items } };
}

