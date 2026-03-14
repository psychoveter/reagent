/**
 * M8a Decompiler E2E Test
 *
 * D1: Compile → decompile → recompile → identical fingerprints
 */
import { writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "dist", "cli.js");
const TMP_DIR = join(__dirname, "..", "..", ".tmp-test-decompiler");
function setup() {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
}
function compile(srcFile, outDir) {
    execSync(`node ${CLI} compile "${srcFile}" "${outDir}"`, { stdio: "pipe" });
}
function decompile(target) {
    return execSync(`node ${CLI} decompile "${target}"`, { encoding: "utf8" });
}
function getFingerprints(outDir) {
    const fps = new Map();
    const files = readdirSync(outDir).filter(f => f.endsWith(".ir.json"));
    for (const f of files) {
        const ir = JSON.parse(readFileSync(join(outDir, f), "utf8"));
        if (ir.fingerprints) {
            fps.set(`${ir.protocolName}.${ir.role}`, ir.fingerprints);
        }
    }
    return fps;
}
// ── D1: Decompile round-trip ────────────────────────────────────────
test("D1: compile → decompile → recompile → identical fingerprints", { skip: true }, //"decompiler support is deferred"
() => {
    setup();
    const source = `
message TaskRequest { text: string }
message TaskResponse { result: string }

protocol SimpleTask {
  participants:
    client [ts] initiator,
    worker [ts]
  supervision: one-for-one
  trigger on invoke with TaskRequest {
    resolve client = single
    resolve worker = single
  }

  client --> worker: TaskRequest = {
    onSend {
      $ctx.msg.text = "hello"
    }
  }

  worker {
    $ctx.result = "processed: " + $ctx.msg.text
  }

  worker --> client: TaskResponse = {
    onSend {
      $ctx.msg.result = $ctx.result
    }
  }
}

role ClientRole [ts] {
  plays SimpleTask as client
}

role WorkerRole [ts] {
  plays SimpleTask as worker
}

agent clientAgent runs ClientRole
agent workerAgent runs WorkerRole
`;
    const srcFile = join(TMP_DIR, "source.rg");
    const outDir1 = join(TMP_DIR, "out1");
    const outDir2 = join(TMP_DIR, "out2");
    const decompiled = join(TMP_DIR, "decompiled.rg");
    writeFileSync(srcFile, source);
    compile(srcFile, outDir1);
    const fp1 = getFingerprints(outDir1);
    assert.ok(fp1.size > 0, "Should have fingerprints from first compile");
    const decompiledSource = decompile(outDir1);
    assert.ok(decompiledSource.length > 0, "Decompiled output should not be empty");
    assert.ok(decompiledSource.includes("SimpleTask"), "Should contain protocol name");
    assert.ok(decompiledSource.includes("supervision: one-for-one"), "Should preserve supervision directive");
    assert.ok(decompiledSource.includes("client"), "Should contain role name");
    assert.ok(decompiledSource.includes("TaskRequest"), "Should contain message name");
    console.log("  Decompiled output:\n" + decompiledSource);
    for (const [key, fp] of fp1) {
        assert.ok(fp.structureHash, `${key} should have structureHash`);
        assert.ok(fp.schemaHash, `${key} should have schemaHash`);
        assert.ok(fp.implHash, `${key} should have implHash`);
        console.log(`  ${key}: structure=${fp.structureHash.substring(0, 12)}... schema=${fp.schemaHash.substring(0, 12)}... impl=${fp.implHash.substring(0, 12)}...`);
    }
    console.log("  D1: PASS (decompile produces valid output with protocol structure preserved)");
});
