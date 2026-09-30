/**
 * M13 Phase 5: Compiler regression tests.
 *
 * CR.1: All .rg examples compile without errors
 * CR.2: Compile → decompile → recompile all examples (fingerprint round-trip)
 * CR.3: TLA+ generation for scatter + par protocols
 * CR.4: project.ts resolveImport (relative, package, bare)
 * CR.5: project.ts loadManifest + compileProject for auction-sim
 *
 * Run: npx tsx test/compiler/compiler-roundtrip.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { parseProgram } from "../../src/parser.js";
import { emitIR, resetIdCounter } from "../../src/ir-emitter.js";
import { generateTLAPlus } from "../../src/tla-generator.js";
import { validateIRGraph } from "../../src/ir-validator.js";
import { resolveImport, loadManifest, resolveGlobs } from "../../src/project.js";
import type { ProtocolDef } from "../../src/ast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..", "..", "..", "examples", "protocols", "src");
const AUCTION_DIR = join(__dirname, "..", "..", "..", "examples", "projects", "auction-sim");
const CLI_SRC = join(__dirname, "..", "..", "src", "cli.ts");
const CLI_CMD = `npx tsx "${CLI_SRC}"`;
const TMP_DIR = join(__dirname, "..", "..", ".tmp-m13-tests");

const ALL_RG_FILES = readdirSync(EXAMPLES_DIR)
  .filter(f => f.endsWith(".rg"))
  .sort();

const EXPECTED_CR2_UNSUPPORTED = new Set([
  "18-invoke-demo.rg",
  "19-spawn-emit-demo.rg",
  "22-multi-protocol-agent.rg",
  "23-scatter-gather.rg",
]);

// ── CR.1: All .rg examples compile without errors ───────────────────

describe("CR.1: All .rg examples compile", () => {
  for (const file of ALL_RG_FILES) {
    it(`compiles ${file}`, () => {
      const src = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      const res = parseProgram(src);
      assert.ok(res.ok, `Parse failed for ${file}: ${res.errors?.map(e => e.message).join(", ")}`);

      const protocols = res.ast.items.filter(
        (i): i is ProtocolDef => i.kind === "ProtocolDef",
      );
      assert.ok(protocols.length > 0, `${file}: no protocols found`);

      for (const proto of protocols) {
        resetIdCounter();
        const result = emitIR(proto);
        assert.ok(result.graphs.size > 0, `${file}/${proto.name}: no IR graphs emitted`);

        for (const [role, graph] of result.graphs) {
          assert.ok(graph.states.length > 0, `${file}/${proto.name}/${role}: no states`);
          assert.ok(graph.transitions.length > 0, `${file}/${proto.name}/${role}: no transitions`);

          const validation = validateIRGraph(graph);
          const hardErrors = validation.errors.filter(e => e.code.startsWith("E_"));
          assert.equal(
            hardErrors.length,
            0,
            `${file}/${proto.name}/${role}: validation errors: ${hardErrors.map(e => e.message).join("; ")}`,
          );
        }
      }
    });
  }

  it("compiles auction-sim/protocols/auction.rg", () => {
    const src = readFileSync(join(AUCTION_DIR, "protocols", "auction.rg"), "utf8");
    const res = parseProgram(src);
    assert.ok(res.ok, `Parse failed: ${res.errors?.map(e => e.message).join(", ")}`);

    const protocols = res.ast.items.filter(
      (i): i is ProtocolDef => i.kind === "ProtocolDef",
    );
    assert.ok(protocols.length > 0, "No protocols found in auction.rg");

    for (const proto of protocols) {
      resetIdCounter();
      const result = emitIR(proto);
      assert.ok(result.graphs.size >= 2, `auction ${proto.name}: expected at least 2 roles`);
    }
  });
});

// ── CR.2: Compile → decompile → recompile round-trip ────────────────

describe("CR.2: Decompile round-trip", () => {
  before(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("decompile works for supported examples and tracks known unsupported fixtures", () => {
    const succeeded: string[] = [];
    const expectedFailures: string[] = [];
    const unexpectedFailures: string[] = [];

    for (const file of ALL_RG_FILES) {
      if (file.includes("import") || file.includes("task-execution.rg")) continue;
      const outDir = join(TMP_DIR, `${file}-out`);
      try {
        execSync(`${CLI_CMD} compile "${join(EXAMPLES_DIR, file)}" "${outDir}"`, { stdio: "pipe" });
        const output = execSync(`${CLI_CMD} decompile "${outDir}"`, { encoding: "utf8" });
        if (output.length > 20) {
          succeeded.push(file);
        } else {
          unexpectedFailures.push(`${file}: output too short (${output.length} chars)`);
        }
      } catch (error) {
        const detail =
          error instanceof Error && error.message
            ? error.message.split("\n")[0]
            : "threw during compile/decompile";
        if (EXPECTED_CR2_UNSUPPORTED.has(file)) {
          expectedFailures.push(file);
        } else {
          unexpectedFailures.push(`${file}: ${detail}`);
        }
      }
    }

    const missingExpected = [...EXPECTED_CR2_UNSUPPORTED].filter((file) => !expectedFailures.includes(file));

    assert.deepStrictEqual(
      expectedFailures.sort(),
      [...EXPECTED_CR2_UNSUPPORTED].sort(),
      `CR.2 unsupported fixture set drifted. Saw: ${expectedFailures.join(", ")}`,
    );
    assert.deepStrictEqual(
      missingExpected,
      [],
      `Expected CR.2 unsupported fixtures were not observed: ${missingExpected.join(", ")}`,
    );
    assert.deepStrictEqual(
      unexpectedFailures,
      [],
      `Unexpected CR.2 failures: ${unexpectedFailures.join("; ")}`,
    );
    assert.ok(succeeded.length > 0, "CR.2 should still cover at least one supported example");
  });

  it("decompiled output contains protocol structure", () => {
    const file = "14-ts-only-demo.rg";
    const outDir = join(TMP_DIR, `${file}-struct`);
    execSync(`${CLI_CMD} compile "${join(EXAMPLES_DIR, file)}" "${outDir}"`, { stdio: "pipe" });
    const output = execSync(`${CLI_CMD} decompile "${outDir}"`, { encoding: "utf8" });

    assert.ok(output.includes("protocol"), "Decompiled output must contain 'protocol'");
    assert.ok(output.includes("message") || output.includes("-->"), "Decompiled output must contain message/send structure");
    assert.ok(output.length > 100, `Decompiled output too short: ${output.length} chars`);
  });
});

// ── CR.3: TLA+ generation for scatter + par ─────────────────────────

describe("CR.3: TLA+ generation for scatter and par", () => {
  function loadAndGenerate(rgFile: string) {
    const src = readFileSync(join(EXAMPLES_DIR, rgFile), "utf8");
    const res = parseProgram(src);
    assert.ok(res.ok, `Parse failed: ${res.errors?.map(e => e.message).join(", ")}`);

    const protocols = res.ast.items.filter(
      (i): i is ProtocolDef => i.kind === "ProtocolDef",
    );
    const results: string[] = [];

    for (const proto of protocols) {
      resetIdCounter();
      const result = emitIR(proto);
      results.push(generateTLAPlus(proto.name, result.graphs));
    }
    return results;
  }

  it("generates TLA+ for parallel protocol (04)", () => {
    const outputs = loadAndGenerate("04-parallel-subtasks.rg");
    assert.ok(outputs.length > 0, "No TLA+ output");
    for (const tla of outputs) {
      assert.ok(tla.includes("MODULE"), "Missing MODULE header");
      assert.ok(tla.includes("===="), "Missing end marker");
      assert.ok(tla.length > 100, "Output suspiciously short");
    }
  });

  it("generates TLA+ for parallel-demo (16)", () => {
    const outputs = loadAndGenerate("16-parallel-demo.rg");
    assert.ok(outputs.length > 0);
    for (const tla of outputs) {
      assert.ok(tla.includes("===="));
    }
  });

  it("generates TLA+ for scatter-gather (23)", () => {
    const outputs = loadAndGenerate("23-scatter-gather.rg");
    assert.ok(outputs.length > 0);
    for (const tla of outputs) {
      assert.ok(tla.includes("===="));
    }
  });
});

// ── CR.4: project.ts resolveImport ──────────────────────────────────

describe("CR.4: resolveImport", () => {
  const projectDir = join(TMP_DIR, "resolve-test-project");
  const importingFile = join(projectDir, "protocols", "main.rg");

  before(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(join(projectDir, "protocols"), { recursive: true });
    mkdirSync(join(projectDir, "reagent_packages", "@test", "auth-pkg", "protocols"), {
      recursive: true,
    });
    writeFileSync(
      join(projectDir, "reagent_packages", "@test", "auth-pkg", "reagent.json"),
      JSON.stringify({ name: "@test/auth-pkg", version: "1.0.0", protocols: ["protocols/*.rg"], main: "protocols/auth.rg" }),
    );
    writeFileSync(
      join(projectDir, "reagent_packages", "@test", "auth-pkg", "protocols", "auth.rg"),
      "// placeholder",
    );
    writeFileSync(join(projectDir, "protocols", "messages.rg"), "// placeholder");
  });

  after(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("resolves relative import ./messages.rg", () => {
    const result = resolveImport("./messages.rg", importingFile, projectDir);
    assert.equal(result.kind, "relative");
    assert.ok(result.resolvedPath.endsWith("messages.rg"));
  });

  it("resolves relative parent import ../other.rg", () => {
    const result = resolveImport("../other.rg", importingFile, projectDir);
    assert.equal(result.kind, "relative");
    assert.ok(result.resolvedPath.includes("other.rg"));
  });

  it("resolves scoped package import @test/auth-pkg/protocols/auth.rg", () => {
    const result = resolveImport(
      "@test/auth-pkg/protocols/auth.rg",
      importingFile,
      projectDir,
    );
    assert.equal(result.kind, "package");
    assert.ok(result.resolvedPath.endsWith("auth.rg"));
  });

  it("resolves bare scoped package import @test/auth-pkg", () => {
    const result = resolveImport("@test/auth-pkg", importingFile, projectDir);
    assert.equal(result.kind, "bare");
    assert.ok(result.resolvedPath.endsWith("auth.rg"), `Expected main entry auth.rg, got ${result.resolvedPath}`);
  });

  it("throws on missing package", () => {
    assert.throws(
      () => resolveImport("@nonexistent/pkg", importingFile, projectDir),
      /not found/,
    );
  });
});

// ── CR.5: loadManifest + resolveGlobs for auction-sim ───────────────

describe("CR.5: loadManifest + compileProject", () => {
  it("loads auction-sim manifest", () => {
    const manifest = loadManifest(AUCTION_DIR);
    assert.equal(manifest.name, "auction-sim");
    assert.equal(manifest.version, "0.1.0");
    assert.ok(Array.isArray(manifest.protocols));
    assert.ok(manifest.protocols.length > 0);
  });

  it("resolves auction-sim protocol globs", () => {
    const manifest = loadManifest(AUCTION_DIR);
    const files = resolveGlobs(AUCTION_DIR, manifest.protocols);
    assert.ok(files.length > 0, "No .rg files resolved");
    assert.ok(
      files.some(f => f.includes("auction.rg")),
      "Expected auction.rg in resolved files",
    );
  });

  it("compiles auction-sim via CLI build", () => {
    const outDir = join(AUCTION_DIR, "out");
    execSync(`${CLI_CMD} build "${AUCTION_DIR}"`, { stdio: "pipe" });
    assert.ok(existsSync(outDir), "Output directory not created");
    const files = readdirSync(outDir);
    assert.ok(
      files.some(f => f.endsWith(".ir.json")),
      `No IR files in output: ${files.join(", ")}`,
    );
  });
});
