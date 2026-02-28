/**
 * Reagent Language Server — provides IDE intelligence for .rg files.
 *
 * Uses the bundled @reagent/lang parser for AST-level analysis.
 * Supports single-file and cross-file intelligence via WorkspaceIndex.
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
  FileChangeType,
  InsertTextFormat,
  SemanticTokensBuilder,
  SemanticTokensParams,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

// ── Types mirroring @reagent/lang AST ───────────────────────────────
// We load the compiler dynamically since it's ESM; define minimal types here.

interface Loc { start: { line: number; col: number }; end: { line: number; col: number } }

interface ASTNode { kind: string; loc: Loc; name?: string }
interface ProtocolDef extends ASTNode {
  kind: "ProtocolDef";
  name: string;
  participants: Array<{
    name: string;
    lang: string;
    binding?: string;
    cardinality?: string;
    initiator?: boolean;
    loc: Loc;
  }>;
  initiator: string;
  input: string;
  triggers?: TriggerDecl[];
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
interface ResolveDecl extends ASTNode {
  kind: "ResolveDecl";
  role: string;
  pipeline: Array<{ step: string; [key: string]: any }>;
  loc: Loc;
}

interface TriggerDecl extends ASTNode {
  kind: "TriggerDecl";
  triggerKind: string;
  withType?: string;
  resolveDecls?: ResolveDecl[];
  loc: Loc;
}
interface Program { kind: "Program"; items: ASTNode[] }
interface ParseResult { ok: boolean; ast: Program; errors: Array<{ code: string; message: string; loc: Loc }> }

type ParseFn = (src: string) => ParseResult;

// ── Document index (per-file symbol table) ──────────────────────────

interface ParticipantModifier {
  participantName: string;
  modifier: string;
  protocolName: string;
  loc: Loc;
}

interface DocIndex {
  protocols: ProtocolDef[];
  roles: RoleDef[];
  agents: AgentDef[];
  messages: MessageDef[];
  triggers: Array<{ kind: string; loc: Loc }>;
  participantModifiers: ParticipantModifier[];
  allMessageNames: Set<string>;
  allParticipantNames: Set<string>;
  allProtocolNames: Set<string>;
  allRoleNames: Set<string>;
  allAgentNames: Set<string>;
}

function emptyIndex(): DocIndex {
  return {
    protocols: [], roles: [], agents: [], messages: [],
    triggers: [], participantModifiers: [],
    allMessageNames: new Set(), allParticipantNames: new Set(),
    allProtocolNames: new Set(), allRoleNames: new Set(), allAgentNames: new Set(),
  };
}

// ── Workspace index (cross-file symbol table) ─────────────────────

interface WorkspaceSymbol { uri: string; name: string; loc: Loc }

interface WorkspaceIndex {
  protocols: Map<string, WorkspaceSymbol>;
  roles: Map<string, WorkspaceSymbol>;
  agents: Map<string, WorkspaceSymbol>;
  messages: Map<string, WorkspaceSymbol>;
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
          if ((part as any).modifier) {
            idx.participantModifiers.push({
              participantName: part.name,
              modifier: (part as any).modifier,
              protocolName: p.name,
              loc: part.loc,
            });
          }
        }
        collectMessageNames(p.body, idx.allMessageNames);
        collectTriggers(p.body, idx.triggers);
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
      case "TriggerDecl": {
        const t = item as unknown as TriggerDecl;
        idx.triggers.push({ kind: t.triggerKind ?? t.kind, loc: t.loc });
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

function collectTriggers(items: ASTNode[], triggers: Array<{ kind: string; loc: Loc }>) {
  for (const item of items) {
    if (item.kind === "TriggerDecl") {
      triggers.push({ kind: (item as any).triggerKind ?? item.kind, loc: item.loc });
    }
    if ("body" in item && Array.isArray((item as any).body)) {
      collectTriggers((item as any).body, triggers);
    }
    if ("branches" in item && Array.isArray((item as any).branches)) {
      for (const br of (item as any).branches) {
        if (br.body) collectTriggers(br.body, triggers);
      }
    }
    if ("tryBody" in item) {
      collectTriggers((item as any).tryBody, triggers);
      if ((item as any).catchBody) collectTriggers((item as any).catchBody, triggers);
    }
  }
}

// ── Connection setup ────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let parseFn: ParseFn | null = null;
let parserLoadState: "pending" | "loaded" | "error" = "pending";
let parserLoadError: string | null = null;
const docIndices = new Map<string, DocIndex>();
const docASTs = new Map<string, Program>();
const serverStartTime = Date.now();

let workspaceRootUri: string | null = null;
const workspaceIndex: WorkspaceIndex = {
  protocols: new Map(),
  roles: new Map(),
  agents: new Map(),
  messages: new Map(),
};
let workspaceFileCount = 0;

// ── Semantic token legend ───────────────────────────────────────────

const SEMANTIC_TOKEN_TYPES = [
  "class",      // 0 – protocol names
  "struct",     // 1 – role names
  "type",       // 2 – message names
  "variable",   // 3 – agent names
  "keyword",    // 4 – language keywords
  "function",   // 5 – state/zone names
  "parameter",  // 6 – participant names
  "property",   // 7 – field names in messages
  "string",     // 8 – lang tags [py], [ts]
  "enum",       // 9 – participant modifiers
  "decorator",  // 10 – trigger keywords
] as const;

const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",  // 0
  "definition",   // 1
  "readonly",     // 2
  "deprecated",   // 3
] as const;

const TT: Record<typeof SEMANTIC_TOKEN_TYPES[number], number> = {} as any;
SEMANTIC_TOKEN_TYPES.forEach((t, i) => { (TT as any)[t] = i; });

const TM = {
  declaration: 1 << 0,
  definition:  1 << 1,
  readonly:    1 << 2,
  deprecated:  1 << 3,
} as const;

// ── Structured logging ──────────────────────────────────────────────

type LogLevel = "error" | "warn" | "info" | "debug";
const LOG_LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let configuredLogLevel: LogLevel = "info";

function log(level: LogLevel, msg: string, data?: unknown): void {
  if (LOG_LEVELS[level] > LOG_LEVELS[configuredLogLevel]) return;
  const entry = data !== undefined ? `[${level}] ${msg} ${JSON.stringify(data)}` : `[${level}] ${msg}`;
  switch (level) {
    case "error": connection.console.error(entry); break;
    case "warn":  connection.console.warn(entry);  break;
    case "info":  connection.console.info(entry);   break;
    case "debug": connection.console.log(entry);    break;
  }
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  const settings = params.initializationOptions as Record<string, unknown> | undefined;
  if (settings?.logLevel && typeof settings.logLevel === "string") {
    const lvl = settings.logLevel as LogLevel;
    if (lvl in LOG_LEVELS) configuredLogLevel = lvl;
  }

  workspaceRootUri = params.rootUri ?? null;
  log("info", "Initializing", { rootUri: workspaceRootUri });

  await loadParser();

  if (workspaceRootUri) {
    await discoverAndIndexWorkspace();
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: {
        triggerCharacters: [".", ":", " ", "$", "]"],
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
        },
        full: true,
      },
      workspace: {
        workspaceFolders: { supported: true },
      },
    },
  };
});

connection.onDidChangeConfiguration((change) => {
  const settings = change.settings?.reagent as Record<string, unknown> | undefined;
  if (settings?.logLevel && typeof settings.logLevel === "string") {
    const lvl = settings.logLevel as LogLevel;
    if (lvl in LOG_LEVELS) {
      configuredLogLevel = lvl;
      log("info", `Log level changed to: ${lvl}`);
    }
  }
});

async function loadParser() {
  try {
    const path = require("path");
    const { pathToFileURL } = require("url");
    const langDir = path.join(__dirname, "..", "..", "lang");
    const parserPath = path.join(langDir, "parser.js");
    const mod = await import(pathToFileURL(parserPath).href);
    parseFn = mod.parseProgram;
    parserLoadState = "loaded";
    log("info", `Parser loaded from ${parserPath}`);
  } catch (e) {
    parserLoadState = "error";
    parserLoadError = String(e);
    log("error", `Failed to load parser: ${e}`);
  }
}

// ── Workspace indexing ──────────────────────────────────────────────

function emptyWorkspaceIndex(): void {
  workspaceIndex.protocols.clear();
  workspaceIndex.roles.clear();
  workspaceIndex.agents.clear();
  workspaceIndex.messages.clear();
  workspaceFileCount = 0;
}

function addDocToWorkspaceIndex(uri: string, idx: DocIndex): void {
  for (const p of idx.protocols) {
    workspaceIndex.protocols.set(p.name, { uri, name: p.name, loc: p.loc });
  }
  for (const r of idx.roles) {
    workspaceIndex.roles.set(r.name, { uri, name: r.name, loc: r.loc });
  }
  for (const a of idx.agents) {
    workspaceIndex.agents.set(a.name, { uri, name: a.name, loc: a.loc });
  }
  for (const m of idx.messages) {
    workspaceIndex.messages.set(m.name, { uri, name: m.name, loc: m.loc });
  }
}

function rebuildWorkspaceIndex(): void {
  emptyWorkspaceIndex();
  for (const [uri, idx] of docIndices) {
    addDocToWorkspaceIndex(uri, idx);
  }
  workspaceFileCount = docIndices.size;
}

async function discoverAndIndexWorkspace(): Promise<void> {
  if (!workspaceRootUri || !parseFn) return;

  const fs = require("fs");
  const nodePath = require("path");
  const { fileURLToPath, pathToFileURL } = require("url");

  let rootPath: string;
  try {
    rootPath = fileURLToPath(workspaceRootUri);
  } catch {
    log("warn", "Could not convert workspace rootUri to path", { uri: workspaceRootUri });
    return;
  }

  const rgFiles: string[] = [];

  function walkDir(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "out" || entry === ".git") continue;
      const full = nodePath.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walkDir(full);
      } else if (entry.endsWith(".rg")) {
        rgFiles.push(full);
      }
    }
  }

  walkDir(rootPath);
  log("info", `Workspace scan found ${rgFiles.length} .rg files`, { root: rootPath });

  emptyWorkspaceIndex();

  for (const filePath of rgFiles) {
    const uri = pathToFileURL(filePath).href;
    try {
      const src = fs.readFileSync(filePath, "utf-8");
      const result = parseFn(src);
      docASTs.set(uri, result.ast);
      const idx = buildIndex(result.ast);
      docIndices.set(uri, idx);
      addDocToWorkspaceIndex(uri, idx);
    } catch (e) {
      log("warn", `Failed to index workspace file: ${filePath}`, { error: String(e) });
    }
  }

  workspaceFileCount = rgFiles.length;
  log("info", "Workspace index built", {
    files: workspaceFileCount,
    protocols: workspaceIndex.protocols.size,
    roles: workspaceIndex.roles.size,
    agents: workspaceIndex.agents.size,
    messages: workspaceIndex.messages.size,
  });
}

function reindexWorkspaceFile(fileUri: string): void {
  if (!parseFn) return;

  const fs = require("fs");
  const { fileURLToPath } = require("url");

  let filePath: string;
  try {
    filePath = fileURLToPath(fileUri);
  } catch {
    return;
  }

  try {
    const src = fs.readFileSync(filePath, "utf-8");
    const result = parseFn(src);
    docASTs.set(fileUri, result.ast);
    const idx = buildIndex(result.ast);
    docIndices.set(fileUri, idx);
    log("debug", "Workspace file re-indexed", { uri: fileUri });
  } catch (e) {
    log("warn", `Failed to re-index workspace file`, { uri: fileUri, error: String(e) });
  }

  rebuildWorkspaceIndex();
}

function removeWorkspaceFile(fileUri: string): void {
  docIndices.delete(fileUri);
  docASTs.delete(fileUri);
  rebuildWorkspaceIndex();
  log("debug", "Workspace file removed from index", { uri: fileUri });
}

function uriBasename(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] || uri;
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

connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    if (!change.uri.endsWith(".rg")) continue;

    if (change.type === FileChangeType.Deleted) {
      removeWorkspaceFile(change.uri);
    } else {
      if (documents.get(change.uri)) continue;
      reindexWorkspaceFile(change.uri);
    }
  }
});

function reindex(doc: TextDocument) {
  if (!parseFn) {
    log("warn", "reindex skipped: parser not loaded", { uri: doc.uri });
    return;
  }

  const result = parseFn(doc.getText());
  docASTs.set(doc.uri, result.ast);
  const idx = buildIndex(result.ast);
  docIndices.set(doc.uri, idx);

  rebuildWorkspaceIndex();

  log("debug", "reindex complete", {
    uri: doc.uri,
    protocols: idx.protocols.length,
    messages: idx.messages.length,
    roles: idx.roles.length,
    agents: idx.agents.length,
  });

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

const KNOWN_RESOLVE_STEPS = new Set([
  "all", "single", "from", "filter", "first", "random",
  "roundRobin", "leastLoaded", "fallback", "custom", "sample",
]);

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

    // ── T.11: Collect triggers (from proto.triggers and body) ───────
    const triggers: TriggerDecl[] = [];
    if (proto.triggers) {
      triggers.push(...(proto.triggers as TriggerDecl[]));
    }
    walkProtocolBody(proto.body, (node) => {
      if (node.kind === "TriggerDecl") triggers.push(node as unknown as TriggerDecl);
    });

    // ── T.11: Trigger completeness hint ─────────────────────────────
    if (proto.participants.length > 0 && triggers.length === 0) {
      diagnostics.push({
        severity: DiagnosticSeverity.Hint,
        range: locToRange(proto.loc),
        message: `Protocol '${proto.name}' has participants but no trigger declaration. Consider adding a trigger.`,
        source: "reagent",
      });
    }

    // ── T.11: Missing resolve & pipeline validation ─────────────────
    for (const trigger of triggers) {
      if (trigger.triggerKind === "invoke") {
        const resolvedRoles = new Set<string>();
        if (trigger.resolveDecls) {
          for (const rd of trigger.resolveDecls) {
            resolvedRoles.add(rd.role);

            for (const step of rd.pipeline) {
              if (!KNOWN_RESOLVE_STEPS.has(step.step)) {
                diagnostics.push({
                  severity: DiagnosticSeverity.Warning,
                  range: locToRange(rd.loc),
                  message: `Unknown resolve pipeline step '${step.step}' in resolve for '${rd.role}'`,
                  source: "reagent",
                });
              }
            }
          }
        }

        const initiatorName = proto.initiator;
        for (const part of proto.participants) {
          const isInitiator = part.initiator || part.name === initiatorName;
          if (isInitiator) continue;
          const isStatic = !part.binding || part.binding === "static";
          if (isStatic && !resolvedRoles.has(part.name)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Warning,
              range: locToRange(trigger.loc),
              message: `Participant '${part.name}' (static) has no resolve declaration in trigger on invoke`,
              source: "reagent",
            });
          }
        }
      }

      if (trigger.resolveDecls) {
        for (const rd of trigger.resolveDecls) {
          for (const step of rd.pipeline) {
            if (!KNOWN_RESOLVE_STEPS.has(step.step)) {
              if (trigger.triggerKind !== "invoke") {
                diagnostics.push({
                  severity: DiagnosticSeverity.Warning,
                  range: locToRange(rd.loc),
                  message: `Unknown resolve pipeline step '${step.step}' in resolve for '${rd.role}'`,
                  source: "reagent",
                });
              }
            }
          }
        }
      }
    }

    // ── T.11: Cardinality — single participants in scatter targets ──
    const singleParticipants = new Set(
      proto.participants
        .filter(p => p.cardinality === "single")
        .map(p => p.name),
    );

    if (singleParticipants.size > 0) {
      walkProtocolBody(proto.body, (node) => {
        if (node.kind === "ScatterStmt") {
          const scatter = node as unknown as ScatterStmt;
          if (singleParticipants.has(scatter.itemRole)) {
            diagnostics.push({
              severity: DiagnosticSeverity.Warning,
              range: locToRange(scatter.loc),
              message: `Participant '${scatter.itemRole}' is declared as 'single' but used as scatter target — consider 'many' cardinality`,
              source: "reagent",
            });
          }
        }
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

// ── Semantic tokens ─────────────────────────────────────────────────

const TRIGGER_KEYWORDS = new Set([
  "trigger", "on", "invoke", "cron", "event",
]);

const PARTICIPANT_MODIFIERS = new Set([
  "static", "dynamic", "single", "many", "initiator",
]);

interface SemanticToken {
  line: number;
  col: number;
  length: number;
  type: number;
  modifiers: number;
}

function collectSemanticTokens(ast: Program, source: string): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  const lines = source.split("\n");

  function push(line: number, col: number, length: number, type: number, modifiers: number) {
    if (length > 0 && line >= 0 && col >= 0) {
      tokens.push({ line, col, length, type, modifiers });
    }
  }

  function findKeywordInLine(lineIdx: number, keyword: string, afterCol?: number): number {
    const lineText = lines[lineIdx] ?? "";
    const startSearch = afterCol ?? 0;
    const re = new RegExp(`\\b${keyword}\\b`, "g");
    re.lastIndex = startSearch;
    const m = re.exec(lineText);
    return m ? m.index : -1;
  }

  function emitLangTag(loc: Loc, lang: string | undefined) {
    if (!lang) return;
    const lineIdx = loc.start.line - 1;
    const lineText = lines[lineIdx] ?? "";
    const nameCol = loc.start.col - 1;
    const bracket = lineText.indexOf(`[${lang}]`, nameCol);
    if (bracket >= 0) {
      push(lineIdx, bracket, lang.length + 2, TT.string, 0);
    }
  }

  for (const item of ast.items) {
    switch (item.kind) {
      case "ProtocolDef": {
        const p = item as unknown as ProtocolDef;
        const startLine = p.loc.start.line - 1;

        const kwCol = findKeywordInLine(startLine, "protocol");
        if (kwCol >= 0) {
          push(startLine, kwCol, "protocol".length, TT.keyword, TM.readonly);
        }

        const nameCol = findKeywordInLine(startLine, p.name, kwCol >= 0 ? kwCol + "protocol".length : 0);
        if (nameCol >= 0) {
          push(startLine, nameCol, p.name.length, TT.class, TM.declaration | TM.definition);
        }

        emitParticipantsSection(p);
        emitTriggerSection(p);
        emitProtocolBody(p.body);
        break;
      }
      case "RoleDef": {
        const r = item as unknown as RoleDef;
        const startLine = r.loc.start.line - 1;

        const kwCol = findKeywordInLine(startLine, "role");
        if (kwCol >= 0) {
          push(startLine, kwCol, "role".length, TT.keyword, TM.readonly);
        }

        const nameCol = findKeywordInLine(startLine, r.name, kwCol >= 0 ? kwCol + "role".length : 0);
        if (nameCol >= 0) {
          push(startLine, nameCol, r.name.length, TT.struct, TM.declaration | TM.definition);
        }

        emitLangTag(r.loc, r.lang);

        for (const play of r.plays) {
          const playLine = play.loc.start.line - 1;
          const playsCol = findKeywordInLine(playLine, "plays");
          if (playsCol >= 0) {
            push(playLine, playsCol, "plays".length, TT.keyword, TM.readonly);
          }
          const pnCol = findKeywordInLine(playLine, play.protocolName, playsCol >= 0 ? playsCol + "plays".length : 0);
          if (pnCol >= 0) {
            push(playLine, pnCol, play.protocolName.length, TT.class, 0);
          }
          const asCol = findKeywordInLine(playLine, "as", pnCol >= 0 ? pnCol + play.protocolName.length : 0);
          if (asCol >= 0) {
            push(playLine, asCol, "as".length, TT.keyword, TM.readonly);
            const rnCol = findKeywordInLine(playLine, play.roleName, asCol + "as".length);
            if (rnCol >= 0) {
              push(playLine, rnCol, play.roleName.length, TT.parameter, 0);
            }
          }
        }
        break;
      }
      case "AgentDef": {
        const a = item as unknown as AgentDef;
        const startLine = a.loc.start.line - 1;

        const kwCol = findKeywordInLine(startLine, "agent");
        if (kwCol >= 0) {
          push(startLine, kwCol, "agent".length, TT.keyword, TM.readonly);
        }

        const nameCol = findKeywordInLine(startLine, a.name, kwCol >= 0 ? kwCol + "agent".length : 0);
        if (nameCol >= 0) {
          push(startLine, nameCol, a.name.length, TT.variable, TM.declaration | TM.definition);
        }

        const runsCol = findKeywordInLine(startLine, "runs", nameCol >= 0 ? nameCol + a.name.length : 0);
        if (runsCol >= 0) {
          push(startLine, runsCol, "runs".length, TT.keyword, TM.readonly);
          const roleCol = findKeywordInLine(startLine, a.runs, runsCol + "runs".length);
          if (roleCol >= 0) {
            push(startLine, roleCol, a.runs.length, TT.struct, 0);
          }
        }

        emitLangTag(a.loc, a.lang);
        break;
      }
      case "MessageDef": {
        const m = item as unknown as MessageDef;
        const startLine = m.loc.start.line - 1;

        const kwCol = findKeywordInLine(startLine, "message");
        if (kwCol >= 0) {
          push(startLine, kwCol, "message".length, TT.keyword, TM.readonly);
        }

        const nameCol = findKeywordInLine(startLine, m.name, kwCol >= 0 ? kwCol + "message".length : 0);
        if (nameCol >= 0) {
          push(startLine, nameCol, m.name.length, TT.type, TM.declaration | TM.definition);
        }

        for (const f of m.fields) {
          const fLine = f.loc.start.line - 1;
          const fCol = findKeywordInLine(fLine, f.name);
          if (fCol >= 0) {
            push(fLine, fCol, f.name.length, TT.property, 0);
          }
        }
        break;
      }
    }
  }

  function emitParticipantsSection(p: ProtocolDef) {
    for (const part of p.participants) {
      const partLine = part.loc.start.line - 1;
      const lineText = lines[partLine] ?? "";

      const nameCol = lineText.indexOf(part.name, part.loc.start.col - 1);
      if (nameCol >= 0) {
        push(partLine, nameCol, part.name.length, TT.parameter, TM.declaration);
      }

      emitLangTag(part.loc, part.lang);

      const modifier = (part as any).modifier;
      if (modifier && PARTICIPANT_MODIFIERS.has(modifier)) {
        const mCol = findKeywordInLine(partLine, modifier, nameCol >= 0 ? nameCol + part.name.length : 0);
        if (mCol >= 0) {
          push(partLine, mCol, modifier.length, TT.enum, 0);
        }
      }

      if (lineText.includes("initiator")) {
        const initCol = findKeywordInLine(partLine, "initiator", nameCol >= 0 ? nameCol + part.name.length : 0);
        if (initCol >= 0) {
          push(partLine, initCol, "initiator".length, TT.enum, 0);
        }
      }
    }

    for (let li = p.loc.start.line - 1; li < Math.min(p.loc.start.line + 5, lines.length); li++) {
      const pc = findKeywordInLine(li, "participants");
      if (pc >= 0) {
        push(li, pc, "participants".length, TT.keyword, TM.readonly);
        break;
      }
    }
  }

  function emitTriggerSection(p: ProtocolDef) {
    const searchStart = p.loc.start.line - 1;
    const searchEnd = Math.min(searchStart + 20, p.loc.end.line);

    for (let li = searchStart; li < searchEnd; li++) {
      const trigCol = findKeywordInLine(li, "trigger");
      if (trigCol >= 0) {
        push(li, trigCol, "trigger".length, TT.decorator, 0);

        const onCol = findKeywordInLine(li, "on", trigCol + "trigger".length);
        if (onCol >= 0) push(li, onCol, "on".length, TT.decorator, 0);

        const invokeCol = findKeywordInLine(li, "invoke", onCol >= 0 ? onCol + "on".length : trigCol + "trigger".length);
        if (invokeCol >= 0) push(li, invokeCol, "invoke".length, TT.decorator, 0);

        const cronCol = findKeywordInLine(li, "cron", trigCol + "trigger".length);
        if (cronCol >= 0) push(li, cronCol, "cron".length, TT.decorator, 0);

        const eventCol = findKeywordInLine(li, "event", trigCol + "trigger".length);
        if (eventCol >= 0) push(li, eventCol, "event".length, TT.decorator, 0);

        const withCol = findKeywordInLine(li, "with", trigCol + "trigger".length);
        if (withCol >= 0) push(li, withCol, "with".length, TT.keyword, TM.readonly);
      }

      const resolveCol = findKeywordInLine(li, "resolve");
      if (resolveCol >= 0) {
        push(li, resolveCol, "resolve".length, TT.decorator, 0);

        for (const mod of PARTICIPANT_MODIFIERS) {
          const modCol = findKeywordInLine(li, mod, resolveCol + "resolve".length);
          if (modCol >= 0) {
            push(li, modCol, mod.length, TT.enum, 0);
          }
        }
      }
    }
  }

  function emitProtocolBody(body: ASTNode[]) {
    for (const node of body) {
      switch (node.kind) {
        case "MessageStmt": {
          const msg = node as unknown as MessageStmt;
          const li = msg.loc.start.line - 1;
          const lineText = lines[li] ?? "";

          const fromCol = lineText.indexOf(msg.from, msg.loc.start.col - 1);
          if (fromCol >= 0) push(li, fromCol, msg.from.length, TT.parameter, 0);

          const arrowIdx = lineText.indexOf("-->", fromCol >= 0 ? fromCol : 0);
          if (arrowIdx >= 0) {
            const toCol = lineText.indexOf(msg.to, arrowIdx + 3);
            if (toCol >= 0) push(li, toCol, msg.to.length, TT.parameter, 0);
          }

          const colonIdx = lineText.indexOf(":", arrowIdx >= 0 ? arrowIdx : 0);
          if (colonIdx >= 0) {
            const mnCol = findKeywordInLine(li, msg.messageName, colonIdx);
            if (mnCol >= 0) push(li, mnCol, msg.messageName.length, TT.type, 0);
          }
          break;
        }
        case "InvokeStmt": {
          const inv = node as unknown as InvokeStmt;
          const li = inv.loc.start.line - 1;
          const invCol = findKeywordInLine(li, "invokes");
          if (invCol >= 0) push(li, invCol, "invokes".length, TT.keyword, TM.readonly);
          break;
        }
        case "SpawnStmt": {
          const sp = node as unknown as SpawnStmt;
          const li = sp.loc.start.line - 1;
          const spCol = findKeywordInLine(li, "spawns");
          if (spCol >= 0) push(li, spCol, "spawns".length, TT.keyword, TM.readonly);
          break;
        }
        case "ZoneDef": {
          const z = node as any;
          const li = z.loc.start.line - 1;
          if (z.name) {
            const nameCol = findKeywordInLine(li, z.name);
            if (nameCol >= 0) push(li, nameCol, z.name.length, TT.function, TM.declaration);
          }
          break;
        }
        case "TriggerDecl": {
          const t = node as unknown as TriggerDecl;
          const li = t.loc.start.line - 1;

          for (const kw of TRIGGER_KEYWORDS) {
            const kwCol = findKeywordInLine(li, kw);
            if (kwCol >= 0) push(li, kwCol, kw.length, TT.decorator, 0);
          }
          break;
        }
      }

      const blockKws: Record<string, string> = {
        AltBranch: "alt", ForEach: "foreach", ScatterGather: "scatter",
        TryRecovery: "try", ParBlock: "par",
      };
      const bkw = blockKws[node.kind];
      if (bkw) {
        const li = node.loc.start.line - 1;
        const kwCol = findKeywordInLine(li, bkw);
        if (kwCol >= 0) push(li, kwCol, bkw.length, TT.keyword, TM.readonly);
      }

      if ("body" in node && Array.isArray((node as any).body)) {
        emitProtocolBody((node as any).body);
      }
      if ("branches" in node && Array.isArray((node as any).branches)) {
        for (const br of (node as any).branches) {
          if (br.body) emitProtocolBody(br.body);
        }
      }
      if ("tryBody" in node) {
        emitProtocolBody((node as any).tryBody);
        if ((node as any).catchBody) {
          const catchLine = node.loc.start.line - 1;
          for (let li = catchLine; li < (node.loc.end.line); li++) {
            const cCol = findKeywordInLine(li, "catch");
            if (cCol >= 0) {
              push(li, cCol, "catch".length, TT.keyword, TM.readonly);
              break;
            }
          }
          emitProtocolBody((node as any).catchBody);
        }
      }
    }
  }

  tokens.sort((a, b) => a.line - b.line || a.col - b.col);
  return tokens;
}

connection.onRequest("textDocument/semanticTokens/full", (params: SemanticTokensParams) => {
  const uri = params.textDocument.uri;
  const ast = docASTs.get(uri);
  if (!ast) return { data: [] };

  const doc = documents.get(uri);
  const source = doc ? doc.getText() : "";
  if (!source) return { data: [] };

  const tokens = collectSemanticTokens(ast, source);

  const builder = new SemanticTokensBuilder();
  for (const t of tokens) {
    builder.push(t.line, t.col, t.length, t.type, t.modifiers);
  }
  return builder.build();
});

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
  if (!doc) return null;

  const word = getWordAtPosition(doc, params.position);
  if (!word) return null;

  if (idx) {
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
  }

  const wsMsg = workspaceIndex.messages.get(word);
  if (wsMsg) return Location.create(wsMsg.uri, locToRange(wsMsg.loc));

  const wsProt = workspaceIndex.protocols.get(word);
  if (wsProt) return Location.create(wsProt.uri, locToRange(wsProt.loc));

  const wsRole = workspaceIndex.roles.get(word);
  if (wsRole) return Location.create(wsRole.uri, locToRange(wsRole.loc));

  const wsAgent = workspaceIndex.agents.get(word);
  if (wsAgent) return Location.create(wsAgent.uri, locToRange(wsAgent.loc));

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
      "$ctx": "**$ctx** — per-role isolated working memory. Each role has its own `$ctx`.\n\nFixed fields: `$ctx.instanceId`, `$ctx.input`, `$ctx.msg`, `$ctx.error`\n\nInside scatter: `$ctx._scatterItem`, `$ctx._scatterIdx`",
      "$flow": "**$flow** — REMOVED in v0.0.11. Use `$ctx` instead.",
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
  if (!doc) return [];

  const localIdx = idx ?? emptyIndex();
  const currentUri = params.textDocument.uri;

  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });

  const trimmed = line.trimStart();

  // ── T.10: Filter predicate completions inside filter(...) ─────────
  if (/\bfilter\s*\([^)]*$/.test(trimmed)) {
    return [
      { label: "agent.name", kind: CompletionItemKind.Property, detail: "Agent name accessor" },
      { label: "agent.tags", kind: CompletionItemKind.Property, detail: "Agent tags accessor" },
      { label: "agent.capabilities", kind: CompletionItemKind.Property, detail: "Agent capabilities accessor" },
      { label: "agent.labels.*", kind: CompletionItemKind.Property, detail: "Agent labels (dot-access)" },
      { label: "agent.metadata.*", kind: CompletionItemKind.Property, detail: "Agent metadata (dot-access)" },
      { label: "==", kind: CompletionItemKind.Operator, detail: "Equality operator" },
      { label: "!=", kind: CompletionItemKind.Operator, detail: "Inequality operator" },
      { label: "contains", kind: CompletionItemKind.Operator, detail: "Contains operator" },
      { label: "in", kind: CompletionItemKind.Operator, detail: "Membership operator" },
      { label: "&&", kind: CompletionItemKind.Operator, detail: "Logical AND" },
      { label: "||", kind: CompletionItemKind.Operator, detail: "Logical OR" },
    ];
  }

  // ── T.10: Resolve pipeline step completions ───────────────────────
  if (/\bresolve\b/.test(trimmed)) {
    return [
      { label: "all", kind: CompletionItemKind.Function, detail: "Resolve all matching agents" },
      { label: "single", kind: CompletionItemKind.Function, detail: "Resolve exactly one agent" },
      { label: "from(expr)", kind: CompletionItemKind.Function, detail: "Resolve from expression",
        insertText: "from(${1:expr})", insertTextFormat: InsertTextFormat.Snippet },
      { label: "filter(predicate)", kind: CompletionItemKind.Function, detail: "Filter agents by predicate",
        insertText: "filter(${1:predicate})", insertTextFormat: InsertTextFormat.Snippet },
      { label: "first", kind: CompletionItemKind.Function, detail: "Pick the first match" },
      { label: "random", kind: CompletionItemKind.Function, detail: "Pick a random match" },
      { label: "roundRobin", kind: CompletionItemKind.Function, detail: "Round-robin selection" },
      { label: "leastLoaded", kind: CompletionItemKind.Function, detail: "Pick least-loaded agent" },
      { label: "fallback(chain)", kind: CompletionItemKind.Function, detail: "Fallback resolution chain",
        insertText: "fallback(${1:chain})", insertTextFormat: InsertTextFormat.Snippet },
      { label: "custom", kind: CompletionItemKind.Function, detail: "Custom resolution strategy" },
    ];
  }

  // ── T.10: Trigger syntax completions ──────────────────────────────
  if (/\btrigger\s+$/.test(trimmed)) {
    return [
      { label: "on invoke", kind: CompletionItemKind.Keyword, detail: "Trigger on explicit invocation",
        insertText: "on invoke", insertTextFormat: InsertTextFormat.PlainText },
      { label: "on cron", kind: CompletionItemKind.Keyword, detail: "Trigger on cron schedule",
        insertText: "on cron", insertTextFormat: InsertTextFormat.PlainText },
      { label: "on event", kind: CompletionItemKind.Keyword, detail: "Trigger on external event",
        insertText: "on event", insertTextFormat: InsertTextFormat.PlainText },
    ];
  }
  if (isInsideTriggerBlock(doc, params.position)) {
    return [
      { label: "resolve", kind: CompletionItemKind.Keyword, detail: "Resolve agent for participant role" },
      { label: "with", kind: CompletionItemKind.Keyword, detail: "Specify input type for trigger" },
    ];
  }

  // ── T.10: Participant modifier completions after lang tag ─────────
  if (isInsideParticipantsBlock(doc, params.position) && /\]\s*\w*$/.test(trimmed)) {
    return [
      { label: "static", kind: CompletionItemKind.Keyword, detail: "Statically bound participant" },
      { label: "dynamic", kind: CompletionItemKind.Keyword, detail: "Dynamically bound participant" },
      { label: "single", kind: CompletionItemKind.Keyword, detail: "Exactly one agent bound" },
      { label: "many", kind: CompletionItemKind.Keyword, detail: "Multiple agents bound" },
      { label: "initiator", kind: CompletionItemKind.Keyword, detail: "Protocol initiator" },
    ];
  }

  if (trimmed.includes("-->") && trimmed.includes(":")) {
    const items = messageCompletionsWithWorkspace(localIdx, currentUri);
    return items;
  }

  if (trimmed.includes("-->")) {
    return [...localIdx.allParticipantNames].map(name => ({
      label: name,
      kind: CompletionItemKind.Interface,
      detail: "participant",
    }));
  }

  if (/\binvokes\s+$/.test(trimmed) || /\bspawns\s+$/.test(trimmed) || /\bplays\s+$/.test(trimmed)) {
    const items = protocolCompletionsWithWorkspace(localIdx, currentUri);
    return items;
  }

  if (/\bas\s+$/.test(trimmed)) {
    const seen = new Set<string>();
    const items: CompletionItem[] = [];
    for (const name of localIdx.allParticipantNames) {
      seen.add(name);
      items.push({ label: name, kind: CompletionItemKind.Interface, detail: "role/participant" });
    }
    for (const name of localIdx.allRoleNames) {
      if (!seen.has(name)) {
        seen.add(name);
        items.push({ label: name, kind: CompletionItemKind.Interface, detail: "role/participant" });
      }
    }
    for (const [name, sym] of workspaceIndex.roles) {
      if (!seen.has(name)) {
        seen.add(name);
        items.push({ label: name, kind: CompletionItemKind.Interface, detail: `role (from ${uriBasename(sym.uri)})` });
      }
    }
    return items;
  }

  if (/\bruns\s+$/.test(trimmed) || /\bextends\s+$/.test(trimmed)) {
    const items = roleCompletionsWithWorkspace(localIdx, currentUri);
    return items;
  }

  if (trimmed.startsWith("$")) {
    return [
      { label: "$ctx", kind: CompletionItemKind.Variable, detail: "per-role isolated context" },
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
        { label: "trigger", kind: CompletionItemKind.Keyword },
      );
      for (const name of localIdx.allParticipantNames) {
        items.push({ label: name, kind: CompletionItemKind.Interface, detail: "participant" });
      }
    }

    return items;
  }

  return [];
});

function protocolCompletionsWithWorkspace(localIdx: DocIndex, currentUri: string): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const name of localIdx.allProtocolNames) {
    seen.add(name);
    items.push({ label: name, kind: CompletionItemKind.Class, detail: "protocol" });
  }
  for (const [name, sym] of workspaceIndex.protocols) {
    if (!seen.has(name)) {
      seen.add(name);
      items.push({ label: name, kind: CompletionItemKind.Class, detail: `protocol (from ${uriBasename(sym.uri)})` });
    }
  }
  return items;
}

function roleCompletionsWithWorkspace(localIdx: DocIndex, currentUri: string): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const name of localIdx.allRoleNames) {
    seen.add(name);
    items.push({ label: name, kind: CompletionItemKind.Struct, detail: "role" });
  }
  for (const [name, sym] of workspaceIndex.roles) {
    if (!seen.has(name)) {
      seen.add(name);
      items.push({ label: name, kind: CompletionItemKind.Struct, detail: `role (from ${uriBasename(sym.uri)})` });
    }
  }
  return items;
}

function messageCompletionsWithWorkspace(localIdx: DocIndex, currentUri: string): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const name of localIdx.allMessageNames) {
    seen.add(name);
    items.push({ label: name, kind: CompletionItemKind.Event, detail: "message" });
  }
  for (const [name, sym] of workspaceIndex.messages) {
    if (!seen.has(name)) {
      seen.add(name);
      items.push({ label: name, kind: CompletionItemKind.Event, detail: `message (from ${uriBasename(sym.uri)})` });
    }
  }
  return items;
}

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

function isInsideTriggerBlock(doc: TextDocument, pos: Position): boolean {
  const text = doc.getText({
    start: { line: 0, character: 0 },
    end: pos,
  });
  let depth = 0;
  let triggerDepth = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.substring(i).startsWith("trigger ")) {
      triggerDepth = depth;
    }
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (triggerDepth >= 0 && depth <= triggerDepth) triggerDepth = -1;
    }
  }
  return triggerDepth >= 0 && depth > triggerDepth;
}

function isInsideParticipantsBlock(doc: TextDocument, pos: Position): boolean {
  const lineText = doc.getText({
    start: { line: pos.line, character: 0 },
    end: { line: pos.line, character: 1000 },
  });
  if (/\bparticipants\s*:/.test(lineText)) return true;

  for (let l = pos.line - 1; l >= Math.max(0, pos.line - 10); l--) {
    const prev = doc.getText({
      start: { line: l, character: 0 },
      end: { line: l, character: 1000 },
    });
    if (/\bparticipants\s*:/.test(prev)) {
      const between = doc.getText({
        start: { line: l, character: 0 },
        end: pos,
      });
      if (!between.includes("{") && !between.includes("}")) return true;
      break;
    }
    if (/^\s*(protocol|trigger|role|agent|message)\b/.test(prev) || prev.includes("{")) break;
  }
  return false;
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

// ── Custom requests ─────────────────────────────────────────────────

connection.onRequest("reagent/lspStatus", () => {
  const uptimeMs = Date.now() - serverStartTime;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  return {
    parser: parserLoadState === "error"
      ? { state: "error" as const, error: parserLoadError }
      : { state: parserLoadState },
    indexedDocuments: docIndices.size,
    uptimeSeconds: uptimeSec,
    workspace: {
      rootUri: workspaceRootUri,
      indexedFiles: workspaceFileCount,
      protocols: workspaceIndex.protocols.size,
      roles: workspaceIndex.roles.size,
      agents: workspaceIndex.agents.size,
      messages: workspaceIndex.messages.size,
    },
  };
});

// ── Start ───────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
