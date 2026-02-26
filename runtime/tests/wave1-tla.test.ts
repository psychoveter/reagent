/**
 * Wave 1.3: TLA+ generator tests.
 *
 * Verifies that the TLA+ generator produces valid TLA+ modules for
 * examples 00-03 and that generated specs contain expected structural
 * elements (Init, Next, Spec, properties, role processes).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseProgram } from "../../lang/src/parser.js";
import { emitIR, resetIdCounter } from "../../lang/src/ir-emitter.js";
import { generateTLAPlus, generateTLCConfig } from "../../lang/src/tla-generator.js";
import type { ProtocolDef } from "../../lang/src/ast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..", "..", "examples", "protocols", "src");

type TestResult = { name: string; passed: boolean; error?: string };

function loadProtocolGraphs(rgFile: string) {
  const src = readFileSync(join(EXAMPLES_DIR, rgFile), "utf8");
  const res = parseProgram(src);
  if (!res.ok) throw new Error(`Parse failed: ${res.errors.map((e) => e.message).join(", ")}`);

  const protocols = res.ast.items.filter((i): i is ProtocolDef => i.kind === "ProtocolDef");
  const results: Array<{ name: string; graphs: Map<string, any> }> = [];

  for (const proto of protocols) {
    resetIdCounter();
    const result = emitIR(proto);
    results.push({ name: proto.name, graphs: result.graphs });
  }
  return results;
}

// ── TLA1: Linear protocol generates valid TLA+ ─────────────────────

async function testTLA1(): Promise<TestResult> {
  const name = "TLA1: Linear protocol generates valid TLA+";
  try {
    const protos = loadProtocolGraphs("01-task-execution-basic.rg");
    if (protos.length === 0) return { name, passed: false, error: "No protocols found" };

    const { name: protoName, graphs } = protos[0];
    const tla = generateTLAPlus(protoName, graphs);

    const checks = [
      { pattern: "MODULE", desc: "MODULE header" },
      { pattern: "VARIABLES", desc: "VARIABLES section" },
      { pattern: "Init ==", desc: "Init definition" },
      { pattern: "Next ==", desc: "Next definition" },
      { pattern: "Spec ==", desc: "Spec definition" },
      { pattern: "AllCompleted", desc: "AllCompleted property" },
      { pattern: "Completion", desc: "Completion liveness" },
      { pattern: "NoOrphanMessages", desc: "NoOrphanMessages safety" },
      { pattern: "====", desc: "Module end marker" },
    ];

    for (const check of checks) {
      if (!tla.includes(check.pattern)) {
        return { name, passed: false, error: `Missing ${check.desc} (${check.pattern})` };
      }
    }

    const roles = [...graphs.keys()];
    for (const role of roles) {
      if (!tla.includes(`Role: ${role}`)) {
        return { name, passed: false, error: `Missing role section for ${role}` };
      }
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── TLA2: Alt/guard protocol has XOR branches ───────────────────────

async function testTLA2(): Promise<TestResult> {
  const name = "TLA2: Alt/guard protocol has XOR branch modeling";
  try {
    const protos = loadProtocolGraphs("02-await-timeout-and-alt.rg");
    const { name: protoName, graphs } = protos[0];
    const tla = generateTLAPlus(protoName, graphs);

    if (!tla.includes("\\/")) {
      return { name, passed: false, error: "No disjunction found — XOR branches not modeled" };
    }

    if (!tla.includes("channels")) {
      return { name, passed: false, error: "No channels variable — message passing not modeled" };
    }

    if (!tla.includes("Append")) {
      return { name, passed: false, error: "No Append — send operations not modeled" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── TLA3: Loop protocol has back-edges ──────────────────────────────

async function testTLA3(): Promise<TestResult> {
  const name = "TLA3: Loop protocol has guard with multiple transitions";
  try {
    const protos = loadProtocolGraphs("03-loop-retry-backoff.rg");
    const { name: protoName, graphs } = protos[0];
    const tla = generateTLAPlus(protoName, graphs);

    // Loop generates expression guards with \/
    if (!tla.includes("\\/")) {
      return { name, passed: false, error: "No disjunction — loop back-edge not modeled" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── TLA4: Config file generated correctly ───────────────────────────

async function testTLA4(): Promise<TestResult> {
  const name = "TLA4: TLC config file has correct structure";
  try {
    const protos = loadProtocolGraphs("01-task-execution-basic.rg");
    const roles = [...protos[0].graphs.keys()];
    const cfg = generateTLCConfig(protos[0].name, roles);

    const checks = [
      { pattern: "SPECIFICATION Spec", desc: "SPECIFICATION" },
      { pattern: "CONSTANTS", desc: "CONSTANTS" },
      { pattern: "PROPERTIES", desc: "PROPERTIES" },
      { pattern: "Completion", desc: "Completion property" },
      { pattern: "INVARIANTS", desc: "INVARIANTS" },
      { pattern: "NoOrphanMessages", desc: "NoOrphanMessages invariant" },
    ];

    for (const check of checks) {
      if (!cfg.includes(check.pattern)) {
        return { name, passed: false, error: `Missing ${check.desc}` };
      }
    }

    for (const role of roles) {
      if (!cfg.includes(`"${role}"`)) {
        return { name, passed: false, error: `Missing role "${role}" in config` };
      }
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── TLA5: All examples 00-03 generate without errors ────────────────

async function testTLA5(): Promise<TestResult> {
  const name = "TLA5: Examples 00-03 all generate valid TLA+";
  try {
    const files = [
      "00-protocol-wrapper.rg",
      "01-task-execution-basic.rg",
      "02-await-timeout-and-alt.rg",
      "03-loop-retry-backoff.rg",
    ];

    for (const file of files) {
      const protos = loadProtocolGraphs(file);
      for (const { name: protoName, graphs } of protos) {
        const tla = generateTLAPlus(protoName, graphs);
        if (!tla.includes("====")) {
          return { name, passed: false, error: `${file}/${protoName}: missing end marker` };
        }
        if (tla.length < 100) {
          return { name, passed: false, error: `${file}/${protoName}: suspiciously short output (${tla.length} chars)` };
        }
      }
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([testTLA1(), testTLA2(), testTLA3(), testTLA4(), testTLA5()]);
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    if (!r.passed) allPassed = false;
  }
  if (!allPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
