/**
 * Reagent Language Server — provides IDE intelligence for .rg files.
 *
 * Uses the bundled @reagent/lang parser for AST-level analysis.
 * Single-file scope first; cross-file via imports later (Phase 7).
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  Hover,
  MarkupKind,
  Diagnostic,
  DiagnosticSeverity,
  SymbolInformation,
  SymbolKind,
  DocumentSymbol,
  Location,
  Range,
  Position,
  TextDocumentPositionParams,
  DocumentSymbolParams,
  CompletionParams,
  DidChangeConfigurationNotification,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

// ── Types mirroring @reagent/lang AST ───────────────────────────────
// We load the compiler dynamically since it's ESM; define minimal types here.

interface Loc { start: { line: number; col: number }; end: { line: number; col: number } }

interface ASTNode { kind: string; loc: Loc; name?: string }
interface ProtocolDef extends ASTNode {
  kind: "ProtocolDef";
  name: string;
  participants: Array<{ name: string; lang: string; loc: Loc }>;
  initiator: string;
  input: string;
  body: ASTNode[];
}
interface RoleDef extends ASTNode {
  kind: "RoleDef";
  name: string;
  lang?: string;
  extends?: string;
  plays: Array<{ protocolName: string; roleName: string; loc: Loc }>;
  loc: Loc;
}
interface AgentDef extends ASTNode {
  kind: "AgentDef";
  name: string;
  lang?: string;
  runs: string;
  loc: Loc;
}
interface MessageDef extends ASTNode {
  kind: "MessageDef";
  name: string;
  fields: Array<{ name: string; type: any; optional: boolean; loc: Loc }>;
  loc: Loc;
}
interface MessageStmt extends ASTNode {
  kind: "MessageStmt";
  from: string;
  to: string;
  messageName: string;
  loc: Loc;
}
interface InvokeStmt extends ASTNode {
  kind: "InvokeStmt";
  protocolName: string;
  callerRole: string;
  loc: Loc;
}
interface SpawnStmt extends ASTNode {
  kind: "SpawnStmt";
  protocolName: string;
  callerRole: string;
  loc: Loc;
}
interface ScatterStmt extends ASTNode {
  kind: "ScatterStmt";
  collection: string;
  itemRole: string;
  body: ASTNode[];
  loc: Loc;
}
interface Program { kind: "Program"; items: ASTNode[] }
interface ParseResult { ok: boolean; ast: Program; errors: Array<{ code: string; message: string; loc: Loc }> }

type ParseFn = (src: string) => ParseResult;

// ── Document index (per-file symbol table) ──────────────────────────

interface DocIndex {
  protocols: ProtocolDef[];
  roles: RoleDef[];
  agents: AgentDef[];
  messages: MessageDef[];
  allMessageNames: Set<string>;
  allParticipantNames: Set<string>;
  allProtocolNames: Set<string>;
  allRoleNames: Set<string>;
  allAgentNames: Set<string>;
}

function emptyIndex(): DocIndex {
  return {
    protocols: [], roles: [], agents: [], messages: [],
    allMessageNames: new Set(), allParticipantNames: new Set(),
    allProtocolNames: new Set(), allRoleNames: new Set(), allAgentNames: new Set(),
  };
}

function buildIndex(ast: Program): DocIndex {
  const idx = emptyIndex();
  for (const item of ast.items) {
    switch (item.kind) {
      case "ProtocolDef": {
        const p = item as unknown as ProtocolDef;
        idx.protocols.push(p);
        idx.allProtocolNames.add(p.name);
        for (const part of p.participants) {
          idx.allParticipantNames.add(part.name);
        }
        collectMessageNames(p.body, idx.allMessageNames);
        break;
      }
      case "RoleDef": {
        const r = item as unknown as RoleDef;
        idx.roles.push(r);
        idx.allRoleNames.add(r.name);
        break;
      }
      case "AgentDef": {
        const a = item as unknown as AgentDef;
        idx.agents.push(a);
        idx.allAgentNames.add(a.name);
        break;
      }
      case "MessageDef": {
        const m = item as unknown as MessageDef;
        idx.messages.push(m);
        idx.allMessageNames.add(m.name);
        break;
      }
    }
  }
  return idx;
}

function collectMessageNames(items: ASTNode[], set: Set<string>) {
  for (const item of items) {
    if (item.kind === "MessageStmt") {
      set.add((item as unknown as MessageStmt).messageName);
    }
    if ("body" in item && Array.isArray((item as any).body)) {
      collectMessageNames((item as any).body, set);
    }
    if ("branches" in item && Array.isArray((item as any).branches)) {
      for (const br of (item as any).branches) {
        if (br.body) collectMessageNames(br.body, set);
      }
    }
    if ("tryBody" in item) {
      collectMessageNames((item as any).tryBody, set);
      if ((item as any).catchBody) collectMessageNames((item as any).catchBody, set);
    }
  }
}

// ── Connection setup ────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let parseFn: ParseFn | null = null;
const docIndices = new Map<string, DocIndex>();
const docASTs = new Map<string, Program>();

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  await loadParser();

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: {
        triggerCharacters: [".", ":", " ", "$"],
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
    },
  };
});

async function loadParser() {
  try {
    const path = require("path");
    const { pathToFileURL } = require("url");
    const langDir = path.join(__dirname, "..", "..", "lang");
    const parserPath = path.join(langDir, "parser.js");
    const mod = await import(pathToFileURL(parserPath).href);
    parseFn = mod.parseProgram;
    connection.console.info(`Parser loaded from ${parserPath}`);
  } catch (e) {
    connection.console.error(`Failed to load parser: ${e}`);
  }
}

// ── Document lifecycle ──────────────────────────────────────────────

documents.onDidChangeContent(change => {
  reindex(change.document);
});

documents.onDidClose(e => {
  docIndices.delete(e.document.uri);
  docASTs.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

function reindex(doc: TextDocument) {
  if (!parseFn) {
    connection.console.warn(`reindex skipped: parser not loaded (uri=${doc.uri})`);
    return;
  }

  const result = parseFn(doc.getText());
  docASTs.set(doc.uri, result.ast);
  const idx = buildIndex(result.ast);
  docIndices.set(doc.uri, idx);

  connection.console.info(`reindex: ${doc.uri} → ${idx.protocols.length} protocols, ${idx.messages.length} messages, ${idx.roles.length} roles, ${idx.agents.length} agents`);

  const diagnostics: Diagnostic[] = [];

  for (const err of result.errors) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: locToRange(err.loc),
      message: err.message,
      source: "reagent",
      code: err.code,
    });
  }

  validateSemantics(idx, doc, diagnostics);

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

function validateSemantics(idx: DocIndex, doc: TextDocument, diagnostics: Diagnostic[]) {
  for (const proto of idx.protocols) {
    const participantNames = new Set(proto.participants.map(p => p.name));

    walkProtocolBody(proto.body, (node) => {
      if (node.kind === "MessageStmt") {
        const msg = node as unknown as MessageStmt;
        if (!participantNames.has(msg.from)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: locToRange(msg.loc),
            message: `Undefined participant '${msg.from}' in protocol '${proto.name}'`,
            source: "reagent",
          });
        }
        if (!participantNames.has(msg.to)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: locToRange(msg.loc),
            message: `Undefined participant '${msg.to}' in protocol '${proto.name}'`,
            source: "reagent",
          });
        }
      }
    });

    if (proto.initiator && !participantNames.has(proto.initiator)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: locToRange(proto.loc),
        message: `Initiator '${proto.initiator}' is not listed in participants`,
        source: "reagent",
      });
    }
  }

  for (const agent of idx.agents) {
    if (!idx.allRoleNames.has(agent.runs)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: locToRange(agent.loc),
        message: `Agent '${agent.name}' runs undefined role '${agent.runs}'`,
        source: "reagent",
      });
    }
  }

  for (const role of idx.roles) {
    for (const play of role.plays) {
      if (!idx.allProtocolNames.has(play.protocolName)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: locToRange(play.loc),
          message: `Role '${role.name}' plays undefined protocol '${play.protocolName}'`,
          source: "reagent",
        });
      }
    }
    if (role.extends && !idx.allRoleNames.has(role.extends)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: locToRange(role.loc),
        message: `Role '${role.name}' extends undefined role '${role.extends}'`,
        source: "reagent",
      });
    }
  }
}

function walkProtocolBody(items: ASTNode[], visitor: (node: ASTNode) => void) {
  for (const item of items) {
    visitor(item);
    if ("body" in item && Array.isArray((item as any).body)) {
      walkProtocolBody((item as any).body, visitor);
    }
    if ("branches" in item && Array.isArray((item as any).branches)) {
      for (const br of (item as any).branches) {
        if (br.body) walkProtocolBody(br.body, visitor);
      }
    }
    if ("tryBody" in item) {
      walkProtocolBody((item as any).tryBody, visitor);
      if ((item as any).catchBody) walkProtocolBody((item as any).catchBody, visitor);
    }
  }
}

// ── Document symbols ────────────────────────────────────────────────

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const idx = docIndices.get(params.textDocument.uri);
  if (!idx) return [];

  const symbols: DocumentSymbol[] = [];

  for (const p of idx.protocols) {
    const children: DocumentSymbol[] = [];
    for (const part of p.participants) {
      children.push({
        name: `${part.name} [${part.lang}]`,
        kind: SymbolKind.Interface,
        range: locToRange(part.loc),
        selectionRange: locToRange(part.loc),
      });
    }
    symbols.push({
      name: p.name,
      detail: `protocol (${p.participants.length} participants)`,
      kind: SymbolKind.Class,
      range: locToRange(p.loc),
      selectionRange: locToRange(p.loc),
      children,
    });
  }

  for (const r of idx.roles) {
    const children: DocumentSymbol[] = [];
    for (const play of r.plays) {
      children.push({
        name: `plays ${play.protocolName} as ${play.roleName}`,
        kind: SymbolKind.Property,
        range: locToRange(play.loc),
        selectionRange: locToRange(play.loc),
      });
    }
    symbols.push({
      name: r.name,
      detail: r.lang ? `role [${r.lang}]` : "role",
      kind: SymbolKind.Struct,
      range: locToRange(r.loc),
      selectionRange: locToRange(r.loc),
      children,
    });
  }

  for (const a of idx.agents) {
    symbols.push({
      name: a.name,
      detail: `agent runs ${a.runs}`,
      kind: SymbolKind.Object,
      range: locToRange(a.loc),
      selectionRange: locToRange(a.loc),
    });
  }

  for (const m of idx.messages) {
    const children: DocumentSymbol[] = m.fields.map(f => ({
      name: `${f.name}${f.optional ? "?" : ""}`,
      detail: typeToString(f.type),
      kind: SymbolKind.Field,
      range: locToRange(f.loc),
      selectionRange: locToRange(f.loc),
    }));
    symbols.push({
      name: m.name,
      detail: `message (${m.fields.length} fields)`,
      kind: SymbolKind.Event,
      range: locToRange(m.loc),
      selectionRange: locToRange(m.loc),
      children,
    });
  }

  return symbols;
});

// ── Go to definition ────────────────────────────────────────────────

connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  const idx = docIndices.get(params.textDocument.uri);
  if (!doc || !idx) return null;

  const word = getWordAtPosition(doc, params.position);
  if (!word) return null;

  for (const m of idx.messages) {
    if (m.name === word) {
      return Location.create(params.textDocument.uri, locToRange(m.loc));
    }
  }

  for (const p of idx.protocols) {
    if (p.name === word) {
      return Location.create(params.textDocument.uri, locToRange(p.loc));
    }
  }

  for (const r of idx.roles) {
    if (r.name === word) {
      return Location.create(params.textDocument.uri, locToRange(r.loc));
    }
  }

  for (const a of idx.agents) {
    if (a.name === word) {
      return Location.create(params.textDocument.uri, locToRange(a.loc));
    }
  }

  return null;
});

// ── Hover ───────────────────────────────────────────────────────────

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  const idx = docIndices.get(params.textDocument.uri);
  if (!doc || !idx) return null;

  const word = getWordAtPosition(doc, params.position);
  if (!word) return null;

  for (const m of idx.messages) {
    if (m.name === word) {
      const fieldsStr = m.fields.length === 0
        ? "(empty payload)"
        : m.fields.map(f => `  ${f.name}${f.optional ? "?" : ""}: ${typeToString(f.type)}`).join("\n");
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**message** \`${m.name}\`\n\`\`\`\n${fieldsStr}\n\`\`\``,
        },
      };
    }
  }

  for (const p of idx.protocols) {
    if (p.name === word) {
      const parts = p.participants.map(pt => `${pt.name} [${pt.lang}]`).join(", ");
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**protocol** \`${p.name}\`\n\nParticipants: ${parts}\n\nInitiator: \`${p.initiator}\`${p.input ? `\n\nInput: \`${p.input}\`` : ""}`,
        },
      };
    }
  }

  for (const r of idx.roles) {
    if (r.name === word) {
      const playsStr = r.plays.map(p => `plays ${p.protocolName} as ${p.roleName}`).join(", ");
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**role** \`${r.name}\`${r.lang ? ` [${r.lang}]` : ""}${r.extends ? ` extends ${r.extends}` : ""}\n\n${playsStr || "(no plays)"}`,
        },
      };
    }
  }

  for (const a of idx.agents) {
    if (a.name === word) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**agent** \`${a.name}\`${a.lang ? ` [${a.lang}]` : ""}\n\nRuns: \`${a.runs}\``,
        },
      };
    }
  }

  if (word.startsWith("$")) {
    const builtins: Record<string, string> = {
      "$ctx": "**$ctx** — per-role isolated working memory. Each role has its own `$ctx`.\n\nFixed fields: `$ctx.instanceId`, `$ctx.input`, `$ctx.msg`, `$ctx.error`",
      "$flow": "**$flow** — message-propagated state. Written by one role, carried with messages, readable by the receiving role.\n\nInside scatter: `$flow._scatterItem`, `$flow._scatterIdx`",
      "$self": "**$self** — role-level persistent state. Survives across protocol instances.",
      "$agent": "**$agent** — optional native module binding. Present when `agent.json` has a `module` field.\n\nProvides access to host-language methods (e.g. `await $agent.think(prompt)`).",
    };
    const prefix = word.split(".")[0];
    if (builtins[prefix]) {
      return { contents: { kind: MarkupKind.Markdown, value: builtins[prefix] } };
    }
  }

  return null;
});

// ── Completion ──────────────────────────────────────────────────────

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  const idx = docIndices.get(params.textDocument.uri);
  if (!doc || !idx) return [];

  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });

  const trimmed = line.trimStart();

  if (trimmed.includes("-->") && trimmed.includes(":")) {
    return [...idx.allMessageNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Event,
      detail: "message",
    }));
  }

  if (trimmed.includes("-->")) {
    return [...idx.allParticipantNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Interface,
      detail: "participant",
    }));
  }

  if (/\binvokes\s+$/.test(trimmed) || /\bspawns\s+$/.test(trimmed)) {
    return [...idx.allProtocolNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Class,
      detail: "protocol",
    }));
  }

  if (/\bplays\s+$/.test(trimmed)) {
    return [...idx.allProtocolNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Class,
      detail: "protocol",
    }));
  }

  if (/\bas\s+$/.test(trimmed)) {
    return [...idx.allParticipantNames, ...idx.allRoleNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Interface,
      detail: "role/participant",
    }));
  }

  if (/\bruns\s+$/.test(trimmed)) {
    return [...idx.allRoleNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Struct,
      detail: "role",
    }));
  }

  if (/\bextends\s+$/.test(trimmed)) {
    return [...idx.allRoleNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Struct,
      detail: "role",
    }));
  }

  if (trimmed.startsWith("$")) {
    return [
      { label: "$ctx", kind: CompletionItemKind.Variable, detail: "per-role isolated context" },
      { label: "$flow", kind: CompletionItemKind.Variable, detail: "message-propagated state" },
      { label: "$self", kind: CompletionItemKind.Variable, detail: "role-level persistent state" },
      { label: "$agent", kind: CompletionItemKind.Variable, detail: "native module binding" },
    ];
  }

  if (trimmed === "" || /^\w*$/.test(trimmed)) {
    const items: CompletionItem[] = [
      { label: "protocol", kind: CompletionItemKind.Keyword },
      { label: "role", kind: CompletionItemKind.Keyword },
      { label: "agent", kind: CompletionItemKind.Keyword },
      { label: "message", kind: CompletionItemKind.Keyword },
      { label: "import", kind: CompletionItemKind.Keyword },
    ];

    if (isInsideProtocolBody(doc, params.position)) {
      items.push(
        { label: "alt", kind: CompletionItemKind.Keyword },
        { label: "loop", kind: CompletionItemKind.Keyword },
        { label: "par", kind: CompletionItemKind.Keyword },
        { label: "wait", kind: CompletionItemKind.Keyword },
        { label: "try", kind: CompletionItemKind.Keyword },
        { label: "scatter", kind: CompletionItemKind.Keyword },
      );
      for (const name of idx.allParticipantNames) {
        items.push({ label: name, kind: CompletionItemKind.Interface, detail: "participant" });
      }
    }

    return items;
  }

  return [];
});

// ── Utilities ───────────────────────────────────────────────────────

function locToRange(loc: Loc): Range {
  return Range.create(
    Position.create(loc.start.line - 1, loc.start.col - 1),
    Position.create(loc.end.line - 1, loc.end.col - 1),
  );
}

function getWordAtPosition(doc: TextDocument, pos: Position): string | null {
  const line = doc.getText({
    start: { line: pos.line, character: 0 },
    end: { line: pos.line, character: 1000 },
  });
  const col = pos.character;

  let start = col;
  while (start > 0 && /[\w$.]/.test(line[start - 1])) start--;
  let end = col;
  while (end < line.length && /[\w$.]/.test(line[end])) end++;

  const word = line.slice(start, end);
  return word.length > 0 ? word : null;
}

function isInsideProtocolBody(doc: TextDocument, pos: Position): boolean {
  const text = doc.getText({
    start: { line: 0, character: 0 },
    end: pos,
  });
  let depth = 0;
  let inProtocol = false;
  for (let i = 0; i < text.length; i++) {
    if (text.substring(i).startsWith("protocol ")) inProtocol = true;
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) inProtocol = false;
    }
  }
  return inProtocol && depth > 0;
}

function typeToString(type: any): string {
  if (!type) return "any";
  switch (type.kind) {
    case "ScalarType": return type.name;
    case "ArrayType": return `${typeToString(type.element)}[]`;
    case "AnyType": return "any";
    case "ObjectType": return `{ ${(type.fields || []).map((f: any) => `${f.name}: ${typeToString(f.type)}`).join(", ")} }`;
    default: return "any";
  }
}

// ── Start ───────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
