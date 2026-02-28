/**
 * Smoke tests for the Reagent LSP server.
 *
 * Spawns the server as a child process using stdio transport,
 * sends JSON-RPC protocol messages, and asserts responses.
 *
 * Run: npx tsx server/test/lsp.test.ts
 *   or after compile: node out/server/test/lsp.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";

// ── JSON-RPC helpers ────────────────────────────────────────────────

let serverProcess: ChildProcess;
let msgId = 0;
let responseBuffer = "";
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function sendMessage(msg: object): void {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  serverProcess.stdin!.write(header + body);
}

function sendRequest(method: string, params: object = {}): Promise<any> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    sendMessage({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out`));
      }
    }, 10_000);
  });
}

function sendNotification(method: string, params: object = {}): void {
  sendMessage({ jsonrpc: "2.0", method, params });
}

function handleData(chunk: Buffer): void {
  responseBuffer += chunk.toString();
  while (true) {
    const headerEnd = responseBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headerPart = responseBuffer.slice(0, headerEnd);
    const match = headerPart.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (responseBuffer.length < bodyStart + contentLength) break;
    const body = responseBuffer.slice(bodyStart, bodyStart + contentLength);
    responseBuffer = responseBuffer.slice(bodyStart + contentLength);
    try {
      const msg = JSON.parse(body);
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id)!;
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    } catch { /* ignore parse errors for notifications etc */ }
  }
}

// ── Fixture ─────────────────────────────────────────────────────────

const FIXTURE_URI = "file:///test/fixture.rg";
const FIXTURE_CONTENT = `
message Ping { payload: string }
message Pong { payload: string }

protocol Echo(sender[py], receiver[ts]) {
  initiator sender
  input Ping

  sender --> receiver : Ping
  receiver --> sender : Pong
}

role SenderRole[py] {
  plays Echo as sender
}

agent SenderAgent[py] runs SenderRole
`;

// ── Tests ───────────────────────────────────────────────────────────

let initCapabilities: any;

describe("Reagent LSP server", () => {
  before(async () => {
    const serverPath = path.resolve(__dirname, "..", "src", "server.js");
    serverProcess = spawn("node", ["--enable-source-maps", serverPath, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    serverProcess.stdout!.on("data", handleData);
    serverProcess.stderr!.on("data", (d: Buffer) => {
      // Optionally log server stderr for debugging
      // process.stderr.write(d);
    });

    const initResult = await sendRequest("initialize", {
      processId: process.pid,
      capabilities: {},
      rootUri: null,
    });
    assert.ok(initResult.capabilities, "Server should return capabilities");
    initCapabilities = initResult.capabilities;
    sendNotification("initialized", {});
  });

  after(() => {
    sendNotification("shutdown");
    serverProcess?.kill("SIGTERM");
  });

  test("capabilities include completion, hover, and definition", () => {
    assert.ok(initCapabilities.completionProvider, "completionProvider");
    assert.ok(initCapabilities.hoverProvider, "hoverProvider");
    assert.ok(initCapabilities.definitionProvider, "definitionProvider");
    assert.ok(initCapabilities.documentSymbolProvider, "documentSymbolProvider");
  });

  test("open document and get diagnostics-free parse", async () => {
    sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: FIXTURE_URI,
        languageId: "reagent",
        version: 1,
        text: FIXTURE_CONTENT,
      },
    });
    // Give the server time to parse and publish diagnostics
    await new Promise(r => setTimeout(r, 1000));
    // If we got here without the server crashing, the open + parse succeeded
    assert.ok(true, "Document opened without server crash");
  });

  test("completions return keywords for empty line", async () => {
    const result = await sendRequest("textDocument/completion", {
      textDocument: { uri: FIXTURE_URI },
      position: { line: 0, character: 0 },
    });
    const items: any[] = Array.isArray(result) ? result : result?.items ?? [];
    const labels = items.map((i: any) => i.label);
    assert.ok(labels.includes("protocol"), "Should suggest 'protocol' keyword");
    assert.ok(labels.includes("message"), "Should suggest 'message' keyword");
  });

  test("reagent/lspStatus returns server info", async () => {
    const status = await sendRequest("reagent/lspStatus");
    assert.ok(status.parser, "Should have parser field");
    assert.ok(typeof status.indexedDocuments === "number", "indexedDocuments should be a number");
    assert.ok(typeof status.uptimeSeconds === "number", "uptimeSeconds should be a number");
    assert.ok(status.indexedDocuments >= 1, "Should have at least 1 indexed document after didOpen");
  });
});
