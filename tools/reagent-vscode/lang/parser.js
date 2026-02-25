/**
 * Reagent recursive-descent parser — v0.0.7
 *
 * Parses a Reagent source string into the typed AST defined in ast.ts.
 * Zone bodies are captured as raw text (brace-balanced, string/comment-aware).
 */
export function parseProgram(src) {
    const c = new Cursor(src);
    const items = [];
    const errors = [];
    for (;;) {
        skipWSAndComments(c);
        if (c.eof())
            break;
        if (startsWithKeyword(c, "import")) {
            const imp = pImportStmt(c);
            if (imp)
                items.push(imp);
            else
                errors.push(makeError("E_IMPORT", "Failed to parse import statement", c));
            continue;
        }
        if (startsWithKeyword(c, "protocol")) {
            const p = pProtocolDef(c);
            if (p)
                items.push(p);
            else
                errors.push(makeError("E_PROTOCOL", "Failed to parse protocol definition", c));
            continue;
        }
        if (startsWithKeyword(c, "agent")) {
            const a = pAgentDef(c);
            if (a)
                items.push(a);
            else
                errors.push(makeError("E_AGENT", "Failed to parse agent definition", c));
            continue;
        }
        if (startsWithKeyword(c, "message")) {
            const m = pMessageDef(c);
            if (m)
                items.push(m);
            else
                errors.push(makeError("E_MESSAGE", "Failed to parse message definition", c));
            continue;
        }
        if (startsWithKeyword(c, "role")) {
            const r = pRoleDef(c);
            if (r)
                items.push(r);
            else
                errors.push(makeError("E_ROLE", "Failed to parse role definition", c));
            continue;
        }
        errors.push(makeError("E_TOP_LEVEL", "Only 'import', 'protocol', 'agent', 'message', and 'role' allowed at top-level", c));
        // skip to next line to recover
        skipToNewline(c);
    }
    return { ok: errors.length === 0, ast: { kind: "Program", items }, errors };
}
// ── Cursor ──────────────────────────────────────────────────────────
class Cursor {
    src;
    i = 0;
    line = 1;
    col = 1;
    constructor(src) {
        this.src = src;
    }
    eof() {
        return this.i >= this.src.length;
    }
    pos() {
        return { index: this.i, line: this.line, col: this.col };
    }
    locFrom(start) {
        return { start, end: this.pos() };
    }
    peek(n = 0) {
        return this.src[this.i + n] ?? "";
    }
    startsWith(s) {
        return this.src.startsWith(s, this.i);
    }
    rest() {
        return this.src.slice(this.i);
    }
    next() {
        const ch = this.peek();
        if (!ch)
            return "";
        this.i += 1;
        if (ch === "\n") {
            this.line += 1;
            this.col = 1;
        }
        else {
            this.col += 1;
        }
        return ch;
    }
    advance(n) {
        for (let k = 0; k < n; k++)
            this.next();
    }
    save() {
        return { i: this.i, line: this.line, col: this.col };
    }
    restore(s) {
        this.i = s.i;
        this.line = s.line;
        this.col = s.col;
    }
}
// ── Helpers ─────────────────────────────────────────────────────────
function makeError(code, message, c) {
    const p = c.pos();
    return { code, message, loc: { start: p, end: p } };
}
function isWS(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
function isIdentStart(ch) {
    return /^[A-Za-z_]$/.test(ch);
}
function isIdentPart(ch) {
    return /^[A-Za-z0-9_\-\.]$/.test(ch);
}
function isDigit(ch) {
    return ch >= "0" && ch <= "9";
}
function skipWSAndComments(c) {
    for (;;) {
        while (!c.eof() && isWS(c.peek()))
            c.next();
        if (c.startsWith("//")) {
            while (!c.eof() && c.peek() !== "\n")
                c.next();
            continue;
        }
        if (c.startsWith("/*")) {
            c.advance(2);
            while (!c.eof() && !c.startsWith("*/"))
                c.next();
            if (c.startsWith("*/"))
                c.advance(2);
            continue;
        }
        break;
    }
}
function skipToNewline(c) {
    while (!c.eof() && c.peek() !== "\n")
        c.next();
    if (!c.eof())
        c.next();
}
function isKeywordBoundary(ch) {
    return ch === "" || !isIdentPart(ch);
}
function startsWithKeyword(c, kw) {
    if (!c.startsWith(kw))
        return false;
    return isKeywordBoundary(c.peek(kw.length));
}
function readIdent(c) {
    const start = c.pos();
    if (!isIdentStart(c.peek()))
        return null;
    let s = c.next();
    while (!c.eof() && isIdentPart(c.peek()))
        s += c.next();
    return { name: s, loc: c.locFrom(start) };
}
function consumeKeyword(c, kw) {
    const start = c.pos();
    if (!startsWithKeyword(c, kw))
        return null;
    c.advance(kw.length);
    return c.locFrom(start);
}
function expectChar(c, ch) {
    skipWSAndComments(c);
    if (c.peek() !== ch)
        return false;
    c.next();
    return true;
}
function readString(c) {
    const start = c.pos();
    const q = c.peek();
    if (q !== '"' && q !== "'")
        return null;
    c.next();
    let out = "";
    while (!c.eof()) {
        const ch = c.next();
        if (ch === q)
            return { value: out, loc: c.locFrom(start) };
        if (ch === "\\") {
            const esc = c.next();
            if (esc === "n")
                out += "\n";
            else if (esc === "r")
                out += "\r";
            else if (esc === "t")
                out += "\t";
            else
                out += esc;
            continue;
        }
        out += ch;
    }
    return null; // unterminated
}
/**
 * Read a brace-balanced raw text block. Cursor must be positioned AFTER the opening `{`.
 * Returns the text between `{` and `}` (exclusive), with string/comment awareness.
 */
function readBalancedBody(c) {
    let depth = 1;
    let body = "";
    let inStr = null;
    let escape = false;
    let inLineComment = false;
    let inBlockComment = false;
    while (!c.eof() && depth > 0) {
        const ch = c.next();
        if (inLineComment) {
            if (ch === "\n")
                inLineComment = false;
            body += ch;
            continue;
        }
        if (inBlockComment) {
            body += ch;
            if (ch === "*" && c.peek() === "/") {
                body += c.next();
                inBlockComment = false;
            }
            continue;
        }
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
            if (ch === inStr)
                inStr = null;
            continue;
        }
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
        if (ch === '"' || ch === "'") {
            inStr = ch;
            body += ch;
            continue;
        }
        if (ch === "{") {
            depth++;
            body += ch;
            continue;
        }
        if (ch === "}") {
            depth--;
            if (depth === 0)
                break;
            body += ch;
            continue;
        }
        body += ch;
    }
    if (depth !== 0)
        return null;
    return body;
}
function readArrow(c) {
    const arrows = ["-->>", "->>", "-->", "->"];
    for (const a of arrows) {
        if (c.startsWith(a)) {
            c.advance(a.length);
            return a;
        }
    }
    return null;
}
function readDuration(c) {
    const start = c.pos();
    let numStr = "";
    while (!c.eof() && isDigit(c.peek()))
        numStr += c.next();
    if (!numStr)
        return null;
    const value = Number(numStr);
    let unit;
    if (c.startsWith("ms")) {
        unit = "ms";
        c.advance(2);
    }
    else if (c.peek() === "s") {
        unit = "s";
        c.next();
    }
    else if (c.peek() === "m") {
        unit = "m";
        c.next();
    }
    else if (c.peek() === "h") {
        unit = "h";
        c.next();
    }
    else
        return null;
    return { value, unit, loc: c.locFrom(start) };
}
// ── Participant list ────────────────────────────────────────────────
const VALID_LANG_TAGS = new Set(["ts", "js", "py", "kt", "*"]);
function pParticipantList(c) {
    const result = [];
    for (;;) {
        skipWSAndComments(c);
        const start = c.pos();
        const id = readIdent(c);
        if (!id)
            return result.length > 0 ? result : null;
        skipWSAndComments(c);
        if (c.peek() !== "[")
            return null;
        c.next();
        skipWSAndComments(c);
        let langTagName;
        if (c.peek() === "*") {
            langTagName = "*";
            c.next();
        }
        else {
            const tagId = readIdent(c);
            if (!tagId || !VALID_LANG_TAGS.has(tagId.name))
                return null;
            langTagName = tagId.name;
        }
        skipWSAndComments(c);
        if (c.peek() !== "]")
            return null;
        c.next();
        result.push({
            kind: "ParticipantDecl",
            name: id.name,
            lang: langTagName,
            loc: c.locFrom(start),
        });
        skipWSAndComments(c);
        if (c.peek() === ",") {
            c.next();
            continue;
        }
        break;
    }
    return result.length > 0 ? result : null;
}
// ── Import statement ────────────────────────────────────────────────
function pImportStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "import"))
        return null;
    skipWSAndComments(c);
    const path = readString(c);
    if (!path)
        return null;
    skipWSAndComments(c);
    let alias;
    if (startsWithKeyword(c, "as")) {
        consumeKeyword(c, "as");
        skipWSAndComments(c);
        const a = readIdent(c);
        if (!a)
            return null;
        alias = a.name;
    }
    skipWSAndComments(c);
    if (c.peek() === ";")
        c.next();
    return { kind: "ImportStmt", path: path.value, alias, loc: c.locFrom(start) };
}
// ── Message props (hooks + pairs) ───────────────────────────────────
function pMessageProps(c) {
    const start = c.pos();
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next(); // consume {
    const hooks = [];
    const pairs = [];
    for (;;) {
        skipWSAndComments(c);
        if (c.eof())
            return null;
        if (c.peek() === "}") {
            c.next();
            break;
        }
        // hook zone: onSend { ... } or onReceive { ... }
        if (startsWithKeyword(c, "onSend") || startsWithKeyword(c, "onReceive")) {
            const hookStart = c.pos();
            const hookType = startsWithKeyword(c, "onSend") ? "onSend" : "onReceive";
            c.advance(hookType.length);
            skipWSAndComments(c);
            if (c.peek() !== "{")
                return null;
            c.next();
            const body = readBalancedBody(c);
            if (body === null)
                return null;
            hooks.push({ kind: "HookZone", hookType, body, loc: c.locFrom(hookStart) });
            continue;
        }
        // key-value pair: key: "value"
        const pairStart = c.pos();
        const key = readIdent(c);
        if (!key)
            return null;
        skipWSAndComments(c);
        if (c.peek() !== ":")
            return null;
        c.next();
        skipWSAndComments(c);
        // Read value as raw text until comma, newline, or closing brace
        const valStart = c.pos();
        let val = "";
        // For string values
        if (c.peek() === '"' || c.peek() === "'") {
            const s = readString(c);
            if (!s)
                return null;
            val = s.value;
        }
        else {
            // Read raw until , or } or newline
            while (!c.eof() && c.peek() !== "," && c.peek() !== "}" && c.peek() !== "\n") {
                val += c.next();
            }
            val = val.trim();
        }
        pairs.push({ kind: "PropPair", key: key.name, value: val, loc: c.locFrom(pairStart) });
        skipWSAndComments(c);
        if (c.peek() === ",") {
            c.next();
            continue;
        }
    }
    return { kind: "MessageProps", hooks, pairs, loc: c.locFrom(start) };
}
// ── Message step ────────────────────────────────────────────────────
function pMessageStmtFromIdent(c, from, fromStart) {
    const start = fromStart;
    skipWSAndComments(c);
    const arrow = readArrow(c);
    if (!arrow)
        return null;
    skipWSAndComments(c);
    const to = readIdent(c);
    if (!to)
        return null;
    skipWSAndComments(c);
    if (c.peek() !== ":")
        return null;
    c.next();
    // Message name: read until end-of-line, `=`, or `{` (for bare messages ending the line)
    skipWSAndComments(c);
    let nameRaw = "";
    while (!c.eof()) {
        const ch = c.peek();
        if (ch === "\n" || ch === "=")
            break;
        // If we hit `{` and it's not preceded by `= `, it's the protocol-level `{` for alt/etc.
        // But for bare messages like `comma --> user: Done = { }` we need `=` first.
        nameRaw += c.next();
    }
    const messageName = nameRaw.trim();
    if (!messageName)
        return null;
    skipWSAndComments(c);
    let props;
    if (c.peek() === "=") {
        c.next();
        skipWSAndComments(c);
        const p = pMessageProps(c);
        if (!p)
            return null;
        props = p;
    }
    return {
        kind: "MessageStmt",
        from,
        arrow,
        to: to.name,
        messageName,
        props,
        loc: c.locFrom(start),
    };
}
// ── Agent zone (standalone) ─────────────────────────────────────────
const PROTOCOL_KEYWORDS = new Set([
    "protocol", "alt", "loop", "par", "try", "catch", "else", "wait",
    "timeout", "and", "import", "break", "participants", "initiator", "input",
    "agent", "plays", "init", "on", "invokes", "spawns", "scatter", "where", "as",
]);
function pAgentZoneFromIdent(c, agent, agentStart, lang) {
    const start = agentStart;
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    const body = readBalancedBody(c);
    if (body === null)
        return null;
    return { kind: "AgentZone", agent, lang, body, loc: c.locFrom(start) };
}
// ── Alt statement ───────────────────────────────────────────────────
/**
 * Parse the guard expression inside `alt (...)` or `else (...)`.
 * The content between parens can be:
 *   - A message guard: `sender --> receiver: MsgName = { ... }`
 *   - A timeout guard: `timeout 10s`
 *   - An expression guard: `$ctx.foo == "bar"`
 */
function pAltGuard(c) {
    const start = c.pos();
    skipWSAndComments(c);
    if (c.peek() !== "(") {
        // `else` without parens = AltElseGuard
        return { kind: "AltElseGuard", loc: c.locFrom(start) };
    }
    c.next(); // consume (
    skipWSAndComments(c);
    // timeout guard
    if (startsWithKeyword(c, "timeout")) {
        consumeKeyword(c, "timeout");
        skipWSAndComments(c);
        const dur = readDuration(c);
        if (!dur)
            return null;
        skipWSAndComments(c);
        if (c.peek() !== ")")
            return null;
        c.next();
        return { kind: "AltTimeoutGuard", duration: dur, loc: c.locFrom(start) };
    }
    // Try to parse as message guard: we need to speculatively read
    // an ident, then check for an arrow
    const saved = c.save();
    const id = readIdent(c);
    if (id) {
        skipWSAndComments(c);
        const arrowSaved = c.save();
        const arrow = readArrow(c);
        if (arrow) {
            // It's a message guard
            skipWSAndComments(c);
            const to = readIdent(c);
            if (!to)
                return null;
            skipWSAndComments(c);
            if (c.peek() !== ":")
                return null;
            c.next();
            skipWSAndComments(c);
            // Message name: read until `=`, `)`, or `where`
            let nameRaw = "";
            while (!c.eof() && c.peek() !== "=" && c.peek() !== ")") {
                if (startsWithKeyword(c, "where"))
                    break;
                nameRaw += c.next();
            }
            const messageName = nameRaw.trim();
            if (!messageName)
                return null;
            let props;
            let whereClause;
            skipWSAndComments(c);
            // `where { key: "value", ... }` — pattern matching clause (v0.0.8)
            if (startsWithKeyword(c, "where")) {
                consumeKeyword(c, "where");
                skipWSAndComments(c);
                if (c.peek() === "{") {
                    c.next();
                    whereClause = {};
                    for (;;) {
                        skipWSAndComments(c);
                        if (c.eof())
                            return null;
                        if (c.peek() === "}") {
                            c.next();
                            break;
                        }
                        const wKey = readIdent(c);
                        if (!wKey)
                            return null;
                        skipWSAndComments(c);
                        if (c.peek() !== ":")
                            return null;
                        c.next();
                        skipWSAndComments(c);
                        let wVal = "";
                        if (c.peek() === '"' || c.peek() === "'") {
                            const s = readString(c);
                            if (!s)
                                return null;
                            wVal = s.value;
                        }
                        else {
                            while (!c.eof() && c.peek() !== "," && c.peek() !== "}" && c.peek() !== "\n") {
                                wVal += c.next();
                            }
                            wVal = wVal.trim();
                        }
                        whereClause[wKey.name] = wVal;
                        skipWSAndComments(c);
                        if (c.peek() === ",")
                            c.next();
                    }
                }
            }
            // Legacy `= { key: val }` syntax (still supported, deprecated)
            if (c.peek() === "=") {
                c.next();
                skipWSAndComments(c);
                const p = pMessageProps(c);
                if (!p)
                    return null;
                props = p;
            }
            skipWSAndComments(c);
            if (c.peek() !== ")")
                return null;
            c.next();
            return {
                kind: "AltMessageGuard",
                from: id.name,
                arrow,
                to: to.name,
                messageName,
                props,
                whereClause,
                loc: c.locFrom(start),
            };
        }
        // Not an arrow — restore and try as expression
        c.restore(saved);
    }
    else {
        c.restore(saved);
    }
    // Expression guard: read raw text until closing `)`
    let expr = "";
    let depth = 1;
    while (!c.eof() && depth > 0) {
        const ch = c.next();
        if (ch === "(")
            depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0)
                break;
        }
        expr += ch;
    }
    expr = expr.trim();
    if (!expr)
        return null;
    return { kind: "AltExprGuard", expr, loc: c.locFrom(start) };
}
function pAltStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "alt"))
        return null;
    skipWSAndComments(c);
    const branches = [];
    // First branch
    const guard = pAltGuard(c);
    if (!guard)
        return null;
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    const body = pProtocolBody(c);
    if (!expectChar(c, "}"))
        return null;
    branches.push({ kind: "AltBranch", guard, body, loc: c.locFrom(start) });
    // else branches
    for (;;) {
        skipWSAndComments(c);
        if (!startsWithKeyword(c, "else"))
            break;
        const branchStart = c.pos();
        consumeKeyword(c, "else");
        skipWSAndComments(c);
        const elseGuard = pAltGuard(c);
        if (!elseGuard)
            return null;
        skipWSAndComments(c);
        if (c.peek() !== "{")
            return null;
        c.next();
        const elseBody = pProtocolBody(c);
        if (!expectChar(c, "}"))
            return null;
        branches.push({ kind: "AltBranch", guard: elseGuard, body: elseBody, loc: c.locFrom(branchStart) });
    }
    return { kind: "AltStmt", branches, loc: c.locFrom(start) };
}
// ── Loop statement ──────────────────────────────────────────────────
function pLoopStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "loop"))
        return null;
    skipWSAndComments(c);
    // Guard in parens
    if (c.peek() !== "(")
        return null;
    c.next();
    let guard = "";
    let depth = 1;
    while (!c.eof() && depth > 0) {
        const ch = c.next();
        if (ch === "(")
            depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0)
                break;
        }
        guard += ch;
    }
    guard = guard.trim();
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    const body = pProtocolBody(c);
    if (!expectChar(c, "}"))
        return null;
    return { kind: "LoopStmt", guard, body, loc: c.locFrom(start) };
}
// ── Par statement ───────────────────────────────────────────────────
function pParStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "par"))
        return null;
    skipWSAndComments(c);
    const branches = [];
    // First branch
    if (c.peek() !== "{")
        return null;
    c.next();
    const firstBody = pProtocolBody(c);
    if (!expectChar(c, "}"))
        return null;
    branches.push({ kind: "ParBranch", body: firstBody, loc: c.locFrom(start) });
    // `and { ... }` branches
    for (;;) {
        skipWSAndComments(c);
        if (!startsWithKeyword(c, "and"))
            break;
        const branchStart = c.pos();
        consumeKeyword(c, "and");
        skipWSAndComments(c);
        if (c.peek() !== "{")
            return null;
        c.next();
        const andBody = pProtocolBody(c);
        if (!expectChar(c, "}"))
            return null;
        branches.push({ kind: "ParBranch", body: andBody, loc: c.locFrom(branchStart) });
    }
    return { kind: "ParStmt", branches, loc: c.locFrom(start) };
}
// ── Wait statement ──────────────────────────────────────────────────
function pWaitStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "wait"))
        return null;
    skipWSAndComments(c);
    const dur = readDuration(c);
    if (!dur)
        return null;
    return { kind: "WaitStmt", duration: dur, loc: c.locFrom(start) };
}
// ── Try/catch statement ─────────────────────────────────────────────
function pTryStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "try"))
        return null;
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    const tryBody = pProtocolBody(c);
    if (!expectChar(c, "}"))
        return null;
    skipWSAndComments(c);
    if (!consumeKeyword(c, "catch"))
        return null;
    skipWSAndComments(c);
    // catch label: `(error)` or `(e)` etc.
    let catchLabel = "error";
    if (c.peek() === "(") {
        c.next();
        let label = "";
        while (!c.eof() && c.peek() !== ")")
            label += c.next();
        if (c.peek() === ")")
            c.next();
        catchLabel = label.trim() || "error";
    }
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    const catchBody = pProtocolBody(c);
    if (!expectChar(c, "}"))
        return null;
    return { kind: "TryStmt", tryBody, catchLabel, catchBody, loc: c.locFrom(start) };
}
// ── Invoke statement ────────────────────────────────────────────────
// Syntax: <role> invokes <Proto>(args) { roleMap } -> $ctx.target
function pInvokeStmtFromIdent(c, callerRole, startPos) {
    // `invokes` keyword already peeked by caller; consume it
    if (!consumeKeyword(c, "invokes"))
        return null;
    skipWSAndComments(c);
    // Protocol name (may be dotted: derive.DeriveDsiBsi)
    const protoId = readIdent(c);
    if (!protoId)
        return null;
    let protocolName = protoId.name;
    while (c.peek() === ".") {
        c.next();
        const next = readIdent(c);
        if (!next)
            return null;
        protocolName += "." + next.name;
    }
    skipWSAndComments(c);
    // Input expression in parens
    if (c.peek() !== "(")
        return null;
    c.next();
    let input = "";
    let depth = 1;
    while (!c.eof() && depth > 0) {
        const ch = c.next();
        if (ch === "(")
            depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0)
                break;
        }
        input += ch;
    }
    input = input.trim();
    skipWSAndComments(c);
    // Optional role mapping: `{ childRole: parentRole, ... }`
    let roleMapping;
    if (c.peek() === "{") {
        c.next();
        roleMapping = {};
        for (;;) {
            skipWSAndComments(c);
            if (c.eof())
                return null;
            if (c.peek() === "}") {
                c.next();
                break;
            }
            const key = readIdent(c);
            if (!key)
                return null;
            skipWSAndComments(c);
            if (c.peek() !== ":")
                return null;
            c.next();
            skipWSAndComments(c);
            const val = readIdent(c);
            if (!val)
                return null;
            roleMapping[key.name] = val.name;
            skipWSAndComments(c);
            if (c.peek() === ",")
                c.next();
        }
    }
    skipWSAndComments(c);
    // Optional result target: `-> $ctx.dsiBsi`
    let resultTarget;
    if (c.startsWith("->")) {
        c.advance(2);
        skipWSAndComments(c);
        let target = "";
        while (!c.eof() && !isWS(c.peek()) && c.peek() !== "\n" && c.peek() !== "}" && c.peek() !== ";") {
            target += c.next();
        }
        resultTarget = target.trim() || undefined;
    }
    return {
        kind: "InvokeStmt",
        protocolName,
        input,
        callerRole,
        roleMapping,
        resultTarget,
        loc: c.locFrom(startPos),
    };
}
// ── Spawn statement ─────────────────────────────────────────────────
// Syntax: <role> spawns <Proto>(args) { roleMap }
function pSpawnStmtFromIdent(c, callerRole, startPos) {
    // `spawns` keyword already peeked by caller; consume it
    if (!consumeKeyword(c, "spawns"))
        return null;
    skipWSAndComments(c);
    const protoId = readIdent(c);
    if (!protoId)
        return null;
    let protocolName = protoId.name;
    while (c.peek() === ".") {
        c.next();
        const next = readIdent(c);
        if (!next)
            return null;
        protocolName += "." + next.name;
    }
    skipWSAndComments(c);
    // Input expression in parens
    if (c.peek() !== "(")
        return null;
    c.next();
    let input = "";
    let depth = 1;
    while (!c.eof() && depth > 0) {
        const ch = c.next();
        if (ch === "(")
            depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0)
                break;
        }
        input += ch;
    }
    input = input.trim();
    skipWSAndComments(c);
    // Optional role mapping: `{ childRole: parentRole, ... }`
    let roleMapping;
    if (c.peek() === "{") {
        c.next();
        roleMapping = {};
        for (;;) {
            skipWSAndComments(c);
            if (c.eof())
                return null;
            if (c.peek() === "}") {
                c.next();
                break;
            }
            const key = readIdent(c);
            if (!key)
                return null;
            skipWSAndComments(c);
            if (c.peek() !== ":")
                return null;
            c.next();
            skipWSAndComments(c);
            const val = readIdent(c);
            if (!val)
                return null;
            roleMapping[key.name] = val.name;
            skipWSAndComments(c);
            if (c.peek() === ",")
                c.next();
        }
    }
    return {
        kind: "SpawnStmt",
        protocolName,
        input,
        callerRole,
        roleMapping,
        loc: c.locFrom(startPos),
    };
}
// ── Scatter statement ───────────────────────────────────────────────
function pScatterStmt(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "scatter"))
        return null;
    skipWSAndComments(c);
    // `($flow.candidates as seller)`
    if (c.peek() !== "(")
        return null;
    c.next();
    skipWSAndComments(c);
    // Read collection expression until `as`
    let collection = "";
    const saved = c.save();
    while (!c.eof()) {
        if (startsWithKeyword(c, "as"))
            break;
        collection += c.next();
    }
    collection = collection.trim();
    if (!collection) {
        c.restore(saved);
        return null;
    }
    if (!consumeKeyword(c, "as"))
        return null;
    skipWSAndComments(c);
    const itemId = readIdent(c);
    if (!itemId)
        return null;
    const itemRole = itemId.name;
    skipWSAndComments(c);
    if (c.peek() !== ")")
        return null;
    c.next();
    skipWSAndComments(c);
    // Body `{ ... }`
    if (c.peek() !== "{")
        return null;
    c.next();
    const body = pProtocolBody(c);
    if (!expectChar(c, "}"))
        return null;
    return {
        kind: "ScatterStmt",
        collection,
        itemRole,
        body,
        loc: c.locFrom(start),
    };
}
// ── Protocol body ───────────────────────────────────────────────────
/**
 * Build a participant name → lang mapping for the current protocol scope.
 * This is called after participants are parsed and used to resolve agent zone languages.
 */
let currentLangMap = new Map();
function pProtocolBody(c) {
    const items = [];
    for (;;) {
        skipWSAndComments(c);
        if (c.eof())
            break;
        if (c.peek() === "}")
            break;
        const item = pProtocolItem(c);
        if (!item)
            break;
        items.push(item);
    }
    return items;
}
function pProtocolItem(c) {
    skipWSAndComments(c);
    if (c.eof() || c.peek() === "}")
        return null;
    // Control-flow keywords
    if (startsWithKeyword(c, "alt"))
        return pAltStmt(c);
    if (startsWithKeyword(c, "loop"))
        return pLoopStmt(c);
    if (startsWithKeyword(c, "par"))
        return pParStmt(c);
    if (startsWithKeyword(c, "wait"))
        return pWaitStmt(c);
    if (startsWithKeyword(c, "try"))
        return pTryStmt(c);
    if (startsWithKeyword(c, "scatter"))
        return pScatterStmt(c);
    // `break` inside loops — parsed as a special WaitStmt-like sentinel
    // Actually, `break` is a host-language construct. It appears inside agent zones, not at protocol level.
    // But example 03 has `break` at protocol indentation inside an alt branch inside a loop.
    // In the examples, `break` appears inside an agent zone: `comma { $ctx.valid = true }` then `break`.
    // Actually looking again — `break` is on its own line after the zone. Let's handle it:
    // `break` at protocol level is NOT valid in v0.0.4; it must be inside an agent zone.
    // But example 03 has it after the zone on its own line. This is an issue we should handle gracefully.
    // Try ident-based: message step or agent zone
    const saved = c.save();
    const id = readIdent(c);
    if (!id) {
        // Skip unexpected character to avoid infinite loop
        c.next();
        return null;
    }
    // Check for `break` keyword (appears in example 03 at protocol level within loops)
    if (id.name === "break") {
        // Treat as a pseudo-statement. We don't have a BreakStmt node,
        // so we model it as an agent zone with empty body on the current role.
        // For now, return null and let it be silently consumed.
        return null;
    }
    skipWSAndComments(c);
    // `<role> invokes <Proto>(...)`
    if (startsWithKeyword(c, "invokes")) {
        return pInvokeStmtFromIdent(c, id.name, id.loc.start);
    }
    // `<role> spawns <Proto>(...)`
    if (startsWithKeyword(c, "spawns")) {
        return pSpawnStmtFromIdent(c, id.name, id.loc.start);
    }
    // If next char is `{`, it's an agent zone (if id is a known participant and not a keyword)
    if (c.peek() === "{" && !PROTOCOL_KEYWORDS.has(id.name)) {
        const lang = currentLangMap.get(id.name) ?? "ts";
        return pAgentZoneFromIdent(c, id.name, id.loc.start, lang);
    }
    // If next chars form an arrow, it's a message step
    const arrowChars = ["-->>", "->>", "-->", "->"];
    const isArrow = arrowChars.some(a => c.startsWith(a));
    if (isArrow) {
        return pMessageStmtFromIdent(c, id.name, id.loc.start);
    }
    // Unknown — restore and skip line
    c.restore(saved);
    skipToNewline(c);
    return null;
}
// ── Protocol definition ─────────────────────────────────────────────
function pProtocolDef(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "protocol"))
        return null;
    skipWSAndComments(c);
    const name = readIdent(c);
    if (!name)
        return null;
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    let participants = [];
    let initiator = "";
    let input = "";
    // Parse directives first (they must appear before body items)
    for (;;) {
        skipWSAndComments(c);
        if (c.eof() || c.peek() === "}")
            break;
        if (startsWithKeyword(c, "participants")) {
            consumeKeyword(c, "participants");
            skipWSAndComments(c);
            if (c.peek() !== ":")
                return null;
            c.next();
            const list = pParticipantList(c);
            if (!list)
                return null;
            participants = list;
            // Update the lang map for zone resolution
            currentLangMap = new Map();
            for (const p of participants)
                currentLangMap.set(p.name, p.lang);
            continue;
        }
        if (startsWithKeyword(c, "initiator")) {
            consumeKeyword(c, "initiator");
            skipWSAndComments(c);
            if (c.peek() !== ":")
                return null;
            c.next();
            skipWSAndComments(c);
            const id = readIdent(c);
            if (!id)
                return null;
            initiator = id.name;
            continue;
        }
        if (startsWithKeyword(c, "input")) {
            consumeKeyword(c, "input");
            skipWSAndComments(c);
            if (c.peek() !== ":")
                return null;
            c.next();
            skipWSAndComments(c);
            const id = readIdent(c);
            if (!id)
                return null;
            input = id.name;
            continue;
        }
        // Not a directive — start parsing body
        break;
    }
    // Parse body items
    const body = pProtocolBody(c);
    skipWSAndComments(c);
    if (c.peek() !== "}")
        return null;
    c.next();
    return {
        kind: "ProtocolDef",
        name: name.name,
        participants,
        initiator,
        input,
        body,
        loc: c.locFrom(start),
    };
}
// ── Agent definition (thin deployment binding) ─────────────────────
// agent Name [lang]? runs RoleName
function pAgentDef(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "agent"))
        return null;
    skipWSAndComments(c);
    const name = readIdent(c);
    if (!name)
        return null;
    skipWSAndComments(c);
    let lang;
    if (c.peek() === "[") {
        c.next();
        skipWSAndComments(c);
        const tagId = readIdent(c);
        if (!tagId || !VALID_LANG_TAGS.has(tagId.name) || tagId.name === "*")
            return null;
        lang = tagId.name;
        skipWSAndComments(c);
        if (c.peek() !== "]")
            return null;
        c.next();
        skipWSAndComments(c);
    }
    if (!consumeKeyword(c, "runs"))
        return null;
    skipWSAndComments(c);
    const roleName = readIdent(c);
    if (!roleName)
        return null;
    return {
        kind: "AgentDef",
        name: name.name,
        lang,
        runs: roleName.name,
        loc: c.locFrom(start),
    };
}
// ── Role definition (primary behavioral contract) ──────────────────
const ROLE_EVENT_KINDS = new Set([
    "protocolStarted",
    "protocolCompleted",
    "protocolFailed",
    "protocolEvent",
]);
function pRoleDef(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "role"))
        return null;
    skipWSAndComments(c);
    const name = readIdent(c);
    if (!name)
        return null;
    skipWSAndComments(c);
    let lang;
    if (c.peek() === "[") {
        c.next();
        skipWSAndComments(c);
        let langTagName;
        if (c.peek() === "*") {
            langTagName = "*";
            c.next();
        }
        else {
            const tagId = readIdent(c);
            if (!tagId || !VALID_LANG_TAGS.has(tagId.name))
                return null;
            langTagName = tagId.name;
        }
        if (!VALID_LANG_TAGS.has(langTagName))
            return null;
        lang = langTagName;
        skipWSAndComments(c);
        if (c.peek() !== "]")
            return null;
        c.next();
        skipWSAndComments(c);
    }
    let extendsRole;
    if (startsWithKeyword(c, "extends")) {
        consumeKeyword(c, "extends");
        skipWSAndComments(c);
        const parentId = readIdent(c);
        if (!parentId)
            return null;
        extendsRole = parentId.name;
        skipWSAndComments(c);
    }
    if (c.peek() !== "{")
        return null;
    c.next();
    const plays = [];
    let init;
    const handlers = [];
    for (;;) {
        skipWSAndComments(c);
        if (c.eof())
            return null;
        if (c.peek() === "}") {
            c.next();
            break;
        }
        if (startsWithKeyword(c, "plays")) {
            const playsStart = c.pos();
            consumeKeyword(c, "plays");
            skipWSAndComments(c);
            const protoName = readIdent(c);
            if (!protoName)
                return null;
            skipWSAndComments(c);
            if (!consumeKeyword(c, "as"))
                return null;
            skipWSAndComments(c);
            const roleName = readIdent(c);
            if (!roleName)
                return null;
            plays.push({
                kind: "PlaysDecl",
                protocolName: protoName.name,
                roleName: roleName.name,
                loc: c.locFrom(playsStart),
            });
            continue;
        }
        if (startsWithKeyword(c, "init")) {
            const initStart = c.pos();
            consumeKeyword(c, "init");
            skipWSAndComments(c);
            if (c.peek() !== "{")
                return null;
            c.next();
            const body = readBalancedBody(c);
            if (body === null)
                return null;
            init = { kind: "RoleInitBlock", body, loc: c.locFrom(initStart) };
            continue;
        }
        if (startsWithKeyword(c, "on")) {
            const onStart = c.pos();
            consumeKeyword(c, "on");
            skipWSAndComments(c);
            const eventId = readIdent(c);
            if (!eventId || !ROLE_EVENT_KINDS.has(eventId.name))
                return null;
            const event = eventId.name;
            skipWSAndComments(c);
            let protocolFilter;
            if (c.peek() === "(") {
                c.next();
                skipWSAndComments(c);
                const filterId = readIdent(c);
                if (!filterId)
                    return null;
                protocolFilter = filterId.name;
                skipWSAndComments(c);
                if (c.peek() !== ")")
                    return null;
                c.next();
            }
            skipWSAndComments(c);
            if (c.peek() !== "{")
                return null;
            c.next();
            const body = readBalancedBody(c);
            if (body === null)
                return null;
            handlers.push({
                kind: "RoleOnHandler",
                event,
                protocolFilter,
                body,
                loc: c.locFrom(onStart),
            });
            continue;
        }
        skipToNewline(c);
    }
    return {
        kind: "RoleDef",
        name: name.name,
        lang,
        extends: extendsRole,
        plays,
        init,
        handlers,
        loc: c.locFrom(start),
    };
}
// ── Message definition (typed payload) ─────────────────────────────
const SCALAR_TYPES = new Set(["string", "number", "boolean"]);
function pTypeExpr(c) {
    skipWSAndComments(c);
    if (c.peek() === "{") {
        c.next();
        const fields = pFieldList(c);
        if (!fields)
            return null;
        skipWSAndComments(c);
        if (c.peek() !== "}")
            return null;
        c.next();
        let te = { kind: "ObjectType", fields };
        while (c.peek() === "[" && c.peek(1) === "]") {
            c.next();
            c.next();
            te = { kind: "ArrayType", element: te };
        }
        return te;
    }
    const id = readIdent(c);
    if (!id)
        return null;
    if (id.name === "any") {
        let te = { kind: "AnyType" };
        while (c.peek() === "[" && c.peek(1) === "]") {
            c.next();
            c.next();
            te = { kind: "ArrayType", element: te };
        }
        return te;
    }
    if (!SCALAR_TYPES.has(id.name))
        return null;
    let te = { kind: "ScalarType", name: id.name };
    while (c.peek() === "[" && c.peek(1) === "]") {
        c.next();
        c.next();
        te = { kind: "ArrayType", element: te };
    }
    return te;
}
function pFieldList(c) {
    const fields = [];
    for (;;) {
        skipWSAndComments(c);
        if (c.eof() || c.peek() === "}")
            break;
        const start = c.pos();
        const name = readIdent(c);
        if (!name)
            break;
        let optional = false;
        if (c.peek() === "?") {
            optional = true;
            c.next();
        }
        skipWSAndComments(c);
        if (c.peek() !== ":")
            return null;
        c.next();
        skipWSAndComments(c);
        const type = pTypeExpr(c);
        if (!type)
            return null;
        fields.push({
            kind: "FieldDef",
            name: name.name,
            type,
            optional,
            loc: c.locFrom(start),
        });
        skipWSAndComments(c);
        if (c.peek() === ",")
            c.next();
    }
    return fields;
}
function pMessageDef(c) {
    const start = c.pos();
    if (!consumeKeyword(c, "message"))
        return null;
    skipWSAndComments(c);
    const name = readIdent(c);
    if (!name)
        return null;
    skipWSAndComments(c);
    if (c.peek() !== "{")
        return null;
    c.next();
    const fields = pFieldList(c);
    if (!fields)
        return null;
    skipWSAndComments(c);
    if (c.peek() !== "}")
        return null;
    c.next();
    return {
        kind: "MessageDef",
        name: name.name,
        fields,
        loc: c.locFrom(start),
    };
}
