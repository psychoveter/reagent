import { readFileSync } from "node:fs";
import { parseProgram } from "./parser.js";
import { emitIR, emitAgentIR, resetIdCounter } from "./ir-emitter.js";
import { validateIRGraph } from "./ir-validator.js";
import type { AgentDef, ProtocolDef } from "./ast.js";

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error("Usage:");
    console.error("  cli.js parse <file>              — parse and output AST");
    console.error("  cli.js ir <file> [role]           — emit IR for all roles (or one)");
    console.error("  cli.js validate <file> [role]     — emit IR + validate");
    process.exit(2);
  }

  const src = readFileSync(file, "utf8");
  const res = parseProgram(src);

  if (cmd === "parse") {
    if (!res.ok) {
      console.error("Parse errors:");
      for (const e of res.errors) {
        console.error(`  [${e.code}] ${e.message} at ${e.loc.start.line}:${e.loc.start.col}`);
      }
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(res.ast, null, 2) + "\n");
    return;
  }

  if (cmd === "ir" || cmd === "validate") {
    if (!res.ok) {
      console.error("Parse errors:");
      for (const e of res.errors) {
        console.error(`  [${e.code}] ${e.message} at ${e.loc.start.line}:${e.loc.start.col}`);
      }
      process.exit(1);
    }

    const roleFilter = rest[0];

    const protocols = res.ast.items.filter(
      (i): i is ProtocolDef => i.kind === "ProtocolDef"
    );

    for (const proto of protocols) {
      resetIdCounter();
      const result = emitIR(proto);

      for (const [role, graph] of result.graphs) {
        if (roleFilter && role !== roleFilter) continue;

        if (cmd === "ir") {
          console.log(`\n=== ${proto.name} / ${role} ===`);
          console.log(JSON.stringify(graph, null, 2));
        }

        if (cmd === "validate") {
          const v = validateIRGraph(graph);
          console.log(`\n=== ${proto.name} / ${role} ===`);
          console.log(`  states: ${v.stats.stateCount}, transitions: ${v.stats.transitionCount}`);
          console.log(`  reachable: ${v.stats.reachableCount}, terminals: ${v.stats.terminalCount}`);
          if (v.ok) {
            console.log("  ✓ valid");
          } else {
            console.log("  ✗ errors:");
            for (const e of v.errors) {
              console.log(`    [${e.code}] ${e.message}`);
            }
          }
        }
      }
    }

    const agents = res.ast.items.filter(
      (i): i is AgentDef => i.kind === "AgentDef"
    );

    for (const agent of agents) {
      const agentResult = emitAgentIR(agent);

      if (cmd === "ir") {
        console.log(`\n=== agent ${agent.name} ===`);
        console.log(JSON.stringify(agentResult.agentIR, null, 2));
      }

      if (cmd === "validate") {
        console.log(`\n=== agent ${agent.name} ===`);
        console.log(`  plays: ${agentResult.agentIR.plays.length}`);
        console.log(`  init: ${agentResult.agentIR.initAction ? "yes" : "no"}`);
        console.log(`  handlers: ${agentResult.agentIR.lifecycleHandlers.length}`);
        if (agentResult.ok) {
          console.log("  ✓ valid");
        } else {
          console.log("  ✗ errors:");
          for (const e of agentResult.errors) {
            console.log(`    ${e}`);
          }
        }
      }
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(2);
}

main();
