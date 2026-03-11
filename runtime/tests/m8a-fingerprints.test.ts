/**
 * M8a Fingerprint E2E Tests
 *
 * F1: Compile same source twice → identical hashes
 * F2: Change one char in zone body → implHash differs, structureHash unchanged
 * F3: Add a new message step → structureHash differs → MAJOR bump
 * F4: Change only zone body → PATCH bump
 * F5: Protocol with invokes → dependencies array populated
 * F6: Compile → lock written. Fresh compile reading lock → same versions
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProgram } from "../../lang/src/parser.js";
import { emitIR, emitMessageSchema, emitRoleIR, resetIdCounter } from "../../lang/src/ir-emitter.js";
import {
  computeProtocolFingerprint,
  computeRoleFingerprint,
  extractUsedMessageNames,
  extractDependencies,
} from "../../lang/src/ir-fingerprint.js";
import {
  readLock,
  writeLock,
  computeProtocolVersion,
  computeRoleVersion,
  classifyProtocolChange,
  type ReagentLock,
} from "../../lang/src/versioning.js";
import type { IRGraph, IRMessageSchema, ProtocolFingerprint } from "../../lang/src/ir.js";
import type { ProtocolDef, MessageDef, RoleDef } from "../../lang/src/ast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "..", "..", ".tmp-test-m8a");

// ── Helpers ─────────────────────────────────────────────────────────

function compileSource(src: string): {
  graphs: Map<string, Map<string, IRGraph>>;
  schemas: IRMessageSchema[];
  roleIRs: Map<string, ReturnType<typeof emitRoleIR>>;
} {
  const res = parseProgram(src);
  assert.ok(res.ok, `Parse failed: ${res.errors.map(e => e.message).join(", ")}`);

  const protocols = res.ast.items.filter((i): i is ProtocolDef => i.kind === "ProtocolDef");
  const messages = res.ast.items.filter((i): i is MessageDef => i.kind === "MessageDef");
  const roles = res.ast.items.filter((i): i is RoleDef => i.kind === "RoleDef");

  const schemas = messages.map(m => emitMessageSchema(m));
  const graphs = new Map<string, Map<string, IRGraph>>();

  for (const proto of protocols) {
    resetIdCounter();
    const result = emitIR(proto);
    assert.ok(result.ok, `Emit failed for ${proto.name}: ${result.errors.join(", ")}`);
    graphs.set(proto.name, result.graphs);
  }

  const roleMap = new Map<string, RoleDef>();
  for (const r of roles) roleMap.set(r.name, r);

  const roleIRs = new Map<string, ReturnType<typeof emitRoleIR>>();
  for (const r of roles) {
    resetIdCounter();
    roleIRs.set(r.name, emitRoleIR(r, roleMap));
  }

  return { graphs, schemas, roleIRs };
}

function fingerprintProtocol(
  graphs: Map<string, IRGraph>,
  schemas: IRMessageSchema[],
): ProtocolFingerprint {
  const usedNames = extractUsedMessageNames(graphs);
  return computeProtocolFingerprint(graphs, schemas, usedNames);
}

// ── Base source for mutation tests ──────────────────────────────────

const BASE_SOURCE = `
message Query {}
message Reply {}

protocol Demo {
  participants:
    a [ts] initiator,
    b [ts]
  trigger on invoke with Query {
    resolve a = single
    resolve b = single
  }

  a --> b: Query = {
    onSend {
      $ctx.msg.text = "hello"
    }
    onReceive {
      $ctx.text = $ctx.msg.text
    }
  }

  b --> a: Reply = {
    onSend {
      $ctx.msg.data = "world"
    }
    onReceive {
      $ctx.data = $ctx.msg.data
    }
  }
}

role RoleA [ts] {
  plays Demo as a
  init {
    $self.ready = true
  }
}

role RoleB [ts] {
  plays Demo as b
  init {
    $self.ready = true
  }
}
`;

// ── F1: Determinism — same source twice → identical hashes ──────────

test("F1: same source compiled twice produces identical fingerprints", () => {
  const r1 = compileSource(BASE_SOURCE);
  const r2 = compileSource(BASE_SOURCE);

  const fp1 = fingerprintProtocol(r1.graphs.get("Demo")!, r1.schemas);
  const fp2 = fingerprintProtocol(r2.graphs.get("Demo")!, r2.schemas);

  assert.deepStrictEqual(fp1, fp2, "Fingerprints should be identical for same source");

  const roleFP1 = computeRoleFingerprint(r1.roleIRs.get("RoleA")!.roleIR);
  const roleFP2 = computeRoleFingerprint(r2.roleIRs.get("RoleA")!.roleIR);
  assert.deepStrictEqual(roleFP1, roleFP2, "Role fingerprints should be identical for same source");
});

// ── F2: Impl change — zone body change → implHash differs, structureHash unchanged

test("F2: zone body change affects implHash only", () => {
  const modified = BASE_SOURCE.replace(
    '$ctx.msg.text = "hello"',
    '$ctx.msg.text = "HELLO"',
  );

  const r1 = compileSource(BASE_SOURCE);
  const r2 = compileSource(modified);

  const fp1 = fingerprintProtocol(r1.graphs.get("Demo")!, r1.schemas);
  const fp2 = fingerprintProtocol(r2.graphs.get("Demo")!, r2.schemas);

  assert.strictEqual(fp1.structureHash, fp2.structureHash, "structureHash should be unchanged");
  assert.strictEqual(fp1.schemaHash, fp2.schemaHash, "schemaHash should be unchanged");
  assert.notStrictEqual(fp1.implHash, fp2.implHash, "implHash should differ");
});

// ── F3: Structure change — add a message step → structureHash differs → MAJOR

test("F3: adding a message step changes structureHash → MAJOR bump", () => {
  const extended = `
message Query {}
message Reply {}
message Ack {}

protocol Demo {
  participants:
    a [ts] initiator,
    b [ts]
  trigger on invoke with Query {
    resolve a = single
    resolve b = single
  }

  a --> b: Query = {
    onSend {
      $ctx.msg.text = "hello"
    }
    onReceive {
      $ctx.text = $ctx.msg.text
    }
  }

  b --> a: Reply = {
    onSend {
      $ctx.msg.data = "world"
    }
    onReceive {
      $ctx.data = $ctx.msg.data
    }
  }

  a --> b: Ack
}

role RoleA [ts] {
  plays Demo as a
  init {
    $self.ready = true
  }
}

role RoleB [ts] {
  plays Demo as b
  init {
    $self.ready = true
  }
}
`;

  const r1 = compileSource(BASE_SOURCE);
  const r2 = compileSource(extended);

  const fp1 = fingerprintProtocol(r1.graphs.get("Demo")!, r1.schemas);
  const fp2 = fingerprintProtocol(r2.graphs.get("Demo")!, r2.schemas);

  assert.notStrictEqual(fp1.structureHash, fp2.structureHash, "structureHash should differ");

  const change = classifyProtocolChange(fp1, fp2);
  assert.strictEqual(change, "major", "Should be a MAJOR change");
});

// ── F4: Impl-only change → PATCH bump ──────────────────────────────

test("F4: impl-only change produces PATCH version bump", () => {
  const modified = BASE_SOURCE.replace(
    '$ctx.msg.data = "world"',
    '$ctx.msg.data = "WORLD"',
  );

  const r1 = compileSource(BASE_SOURCE);
  const r2 = compileSource(modified);

  const fp1 = fingerprintProtocol(r1.graphs.get("Demo")!, r1.schemas);
  const fp2 = fingerprintProtocol(r2.graphs.get("Demo")!, r2.schemas);

  const lock: ReagentLock = {
    protocols: { Demo: { version: "0.1.0", fingerprints: fp1 } },
    roles: {},
  };

  const { version, change } = computeProtocolVersion("Demo", fp2, lock);
  assert.strictEqual(change, "patch");
  assert.strictEqual(version, "0.1.1");
});

// ── F5: Protocol with invokes → dependencies populated ──────────────

test("F5: protocol with invokes populates dependencies", () => {
  const invokeSource = `
message Request {}
message Result {}

protocol SubProto {
  participants:
    worker [ts] initiator
  trigger on invoke with Request {
    resolve worker = single
  }

  worker {
    $ctx.result = 42
    reagent.return($ctx.result)
  }
}

protocol MainProto {
  participants:
    a [ts] initiator,
    b [ts]
  trigger on invoke with Request {
    resolve a = single
    resolve b = single
  }

  a --> b: Request = {
    onSend { $ctx.msg.value = 1 }
    onReceive { $ctx.value = $ctx.msg.value }
  }

  b invokes SubProto({ value: $ctx.value }) -> $ctx.result

  b --> a: Result = {
    onSend { $ctx.msg.data = $ctx.result }
    onReceive { $self.result = $ctx.msg.data }
  }
}

role RoleA [ts] {
  plays MainProto as a
}
role RoleB [ts] {
  plays MainProto as b
  plays SubProto as worker
}
`;

  const result = compileSource(invokeSource);
  const mainGraphs = result.graphs.get("MainProto")!;
  const deps = extractDependencies(mainGraphs);

  assert.ok(deps.length >= 1, "Should have at least one dependency");
  assert.strictEqual(deps[0].protocolName, "SubProto");
});

// ── F6: Lock file round-trip ────────────────────────────────────────

test("F6: lock file write + read produces stable versions", () => {
  mkdirSync(TMP_DIR, { recursive: true });
  const lockPath = join(TMP_DIR, "reagent.lock");

  try {
    const r1 = compileSource(BASE_SOURCE);
    const fp1 = fingerprintProtocol(r1.graphs.get("Demo")!, r1.schemas);
    const { version: v1 } = computeProtocolVersion("Demo", fp1, null);
    assert.strictEqual(v1, "0.1.0", "Initial version should be 0.1.0");

    const lock: ReagentLock = {
      protocols: { Demo: { version: v1, fingerprints: fp1 } },
      roles: {},
    };
    writeLock(lockPath, lock);

    const readBack = readLock(lockPath);
    assert.ok(readBack !== null, "Lock file should be readable");

    // Compile same source again — version should not change
    const r2 = compileSource(BASE_SOURCE);
    const fp2 = fingerprintProtocol(r2.graphs.get("Demo")!, r2.schemas);
    const { version: v2, change } = computeProtocolVersion("Demo", fp2, readBack);
    assert.strictEqual(change, "none");
    assert.strictEqual(v2, "0.1.0", "Version should remain 0.1.0 for unchanged source");
  } finally {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});
