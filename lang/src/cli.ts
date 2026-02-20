import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseProgram } from "./parser.js";
import { emitIR, emitAgentIR, emitMessageSchema, emitRoleIR, resetIdCounter, type SourceMapEntry } from "./ir-emitter.js";
import { validateIRGraph } from "./ir-validator.js";
import type { AgentDef, MessageDef, ProtocolDef, RoleDef } from "./ast.js";

function usage(): never {
  console.error("reagent-lang — Reagent compiler CLI\n");
  console.error("Commands:");
  console.error("  reagent-lang parse    <file.rg>                      — parse and print AST as JSON");
  console.error("  reagent-lang ir       <file.rg> [role]               — emit IR to stdout (optionally filter by role)");
  console.error("  reagent-lang validate <file.rg> [role]               — emit IR, validate, print diagnostics");
  console.error("  reagent-lang compile  <file.rg> <out-dir>            — compile to IR JSON files");
  console.error("");
  console.error("compile output:");
  console.error("  <out-dir>/<Proto>.<role>.ir.json   — per-role IR graph");
  console.error("  <out-dir>/<Role>.role.json         — per-role behavioral IR");
  console.error("  <out-dir>/<Agent>.agent.json       — per-agent deployment binding (references role)");
  console.error("  <out-dir>/deployment.json          — deployment plan (agent→role→graph mapping)");
  process.exit(2);
}

function parseFile(file: string) {
  const src = readFileSync(file, "utf8");
  const res = parseProgram(src);
  if (!res.ok) {
    console.error("Parse errors:");
    for (const e of res.errors) {
      console.error(`  [${e.code}] ${e.message} at ${e.loc.start.line}:${e.loc.start.col}`);
    }
    process.exit(1);
  }
  return res;
}

function getProtocols(res: ReturnType<typeof parseProgram>) {
  return res.ast.items.filter((i): i is ProtocolDef => i.kind === "ProtocolDef");
}

function getAgents(res: ReturnType<typeof parseProgram>) {
  return res.ast.items.filter((i): i is AgentDef => i.kind === "AgentDef");
}

function getMessages(res: ReturnType<typeof parseProgram>) {
  return res.ast.items.filter((i): i is MessageDef => i.kind === "MessageDef");
}

function getRoles(res: ReturnType<typeof parseProgram>) {
  return res.ast.items.filter((i): i is RoleDef => i.kind === "RoleDef");
}

function buildRoleMap(res: ReturnType<typeof parseProgram>): Map<string, RoleDef> {
  const map = new Map<string, RoleDef>();
  for (const r of getRoles(res)) map.set(r.name, r);
  return map;
}

// ── parse ───────────────────────────────────────────────────────────

function cmdParse(file: string) {
  const res = parseFile(file);
  process.stdout.write(JSON.stringify(res.ast, null, 2) + "\n");
}

// ── ir ──────────────────────────────────────────────────────────────

function cmdIR(file: string, roleFilter?: string) {
  const res = parseFile(file);
  const roleMap = buildRoleMap(res);

  for (const proto of getProtocols(res)) {
    resetIdCounter();
    const result = emitIR(proto);
    if (!result.ok) {
      console.error(`\nIR errors in protocol ${proto.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
    }
    for (const [role, graph] of result.graphs) {
      if (roleFilter && role !== roleFilter) continue;
      console.log(`\n=== ${proto.name} / ${role} ===`);
      console.log(JSON.stringify(graph, null, 2));
    }
  }

  for (const role of getRoles(res)) {
    const result = emitRoleIR(role, roleMap);
    if (!result.ok) {
      console.error(`\nRole IR errors in ${role.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
    }
    console.log(`\n=== role ${role.name} ===`);
    console.log(JSON.stringify(result.roleIR, null, 2));
  }

  for (const agent of getAgents(res)) {
    const result = emitAgentIR(agent, roleMap);
    if (!result.ok) {
      console.error(`\nAgent IR errors in ${agent.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
    }
    console.log(`\n=== agent ${agent.name} ===`);
    console.log(JSON.stringify(result.agentIR, null, 2));
  }
}

// ── validate ────────────────────────────────────────────────────────

function cmdValidate(file: string, roleFilter?: string) {
  const res = parseFile(file);
  const roleMap = buildRoleMap(res);

  for (const proto of getProtocols(res)) {
    resetIdCounter();
    const result = emitIR(proto);
    if (!result.ok) {
      console.error(`\nIR emit errors in protocol ${proto.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
    }
    for (const [role, graph] of result.graphs) {
      if (roleFilter && role !== roleFilter) continue;
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

  for (const role of getRoles(res)) {
    const result = emitRoleIR(role, roleMap);
    console.log(`\n=== role ${role.name} ===`);
    console.log(`  lang: ${role.lang ?? "none"}`);
    console.log(`  extends: ${role.extends ?? "none"}`);
    console.log(`  plays: ${result.roleIR.plays.length}`);
    console.log(`  init: ${result.roleIR.initAction ? "yes" : "no"}`);
    console.log(`  handlers: ${result.roleIR.lifecycleHandlers.length}`);
    if (result.ok) {
      console.log("  ✓ valid");
    } else {
      console.log("  ✗ errors:");
      for (const e of result.errors) console.log(`    ${e}`);
    }
  }

  for (const agent of getAgents(res)) {
    const result = emitAgentIR(agent, roleMap);
    console.log(`\n=== agent ${agent.name} ===`);
    console.log(`  runs: ${agent.runs}`);
    console.log(`  lang: ${result.agentIR.lang}`);
    console.log(`  roleFile: ${result.agentIR.roleFile}`);
    if (result.ok) {
      console.log("  ✓ valid");
    } else {
      console.log("  ✗ errors:");
      for (const e of result.errors) console.log(`    ${e}`);
    }
  }
}

// ── compile ─────────────────────────────────────────────────────────

function cmdCompile(file: string, outDir: string) {
  const res = parseFile(file);
  const protocols = getProtocols(res);
  const agents = getAgents(res);
  const roleMap = buildRoleMap(res);
  const roles = getRoles(res);

  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true });

  let protoRoleCount = 0;
  let roleDefCount = 0;
  let agentCount = 0;
  let hasErrors = false;
  const allSourceMapEntries: SourceMapEntry[] = [];

  // Emit per-role IRGraphs
  for (const proto of protocols) {
    resetIdCounter();
    const result = emitIR(proto);

    if (!result.ok) {
      console.error(`IR errors in protocol ${proto.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
      hasErrors = true;
    }

    // Collect source map entries with the file name filled in
    for (const entry of result.sourceMap) {
      allSourceMapEntries.push({ ...entry, file });
    }

    for (const [role, graph] of result.graphs) {
      const v = validateIRGraph(graph);
      if (!v.ok) {
        console.error(`Validation errors in ${proto.name}/${role}:`);
        for (const e of v.errors) console.error(`  [${e.code}] ${e.message}`);
        hasErrors = true;
      }

      const fname = `${proto.name}.${role}.ir.json`;
      writeFileSync(join(outDir, fname), JSON.stringify(graph, null, 2) + "\n");
      console.log(`  ${fname}`);
      protoRoleCount++;
    }
  }

  // Emit per-role RoleIRs (rich behavioral contracts)
  for (const role of roles) {
    const result = emitRoleIR(role, roleMap);
    if (!result.ok) {
      console.error(`Role IR errors in ${role.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
      hasErrors = true;
    }
    const fname = `${role.name}.role.json`;
    writeFileSync(join(outDir, fname), JSON.stringify(result.roleIR, null, 2) + "\n");
    console.log(`  ${fname}`);
    roleDefCount++;
  }

  // Emit per-agent AgentIRs (thin deployment bindings)
  for (const agent of agents) {
    const result = emitAgentIR(agent, roleMap);

    if (!result.ok) {
      console.error(`Agent IR errors in ${agent.name}:`);
      for (const e of result.errors) console.error(`  ${e}`);
      hasErrors = true;
    }

    const fname = `${agent.name}.agent.json`;
    writeFileSync(join(outDir, fname), JSON.stringify(result.agentIR, null, 2) + "\n");
    console.log(`  ${fname}`);
    agentCount++;
  }

  // Deployment plan — derive plays from the resolved role
  type DeploymentAgent = {
    agentName: string;
    lang: string;
    roleName: string;
    agentIRFile: string;
    roleIRFile: string;
    roles: Array<{
      protocolName: string;
      roleName: string;
      irGraphFile: string;
    }>;
  };

  const roleToAgent: Record<string, string> = {};
  const deploymentAgents: DeploymentAgent[] = [];

  for (const agent of agents) {
    const agentResult = emitAgentIR(agent, roleMap);
    const roleDef = roleMap.get(agent.runs);
    const roleResult = roleDef ? emitRoleIR(roleDef, roleMap) : undefined;
    const plays = roleResult?.roleIR.plays ?? [];

    const da: DeploymentAgent = {
      agentName: agent.name,
      lang: agentResult.agentIR.lang,
      roleName: agent.runs,
      agentIRFile: `${agent.name}.agent.json`,
      roleIRFile: `${agent.runs}.role.json`,
      roles: [],
    };
    for (const p of plays) {
      const key = `${p.protocolName}.${p.roleName}`;
      da.roles.push({
        protocolName: p.protocolName,
        roleName: p.roleName,
        irGraphFile: `${key}.ir.json`,
      });
      roleToAgent[key] = agent.name;
    }
    deploymentAgents.push(da);
  }

  // Emit message schemas
  const messages = getMessages(res);
  const schemas = messages.map(m => emitMessageSchema(m));
  if (schemas.length > 0) {
    writeFileSync(join(outDir, "messages.json"), JSON.stringify(schemas, null, 2) + "\n");
    console.log("  messages.json");
  }

  const roleFiles = roles.map(r => ({ name: r.name, file: `${r.name}.role.json` }));
  const deployment = {
    agents: deploymentAgents,
    roleToAgent,
    roles: roleFiles.length > 0 ? roleFiles : undefined,
    messages: schemas.length > 0 ? "messages.json" : undefined,
  };
  writeFileSync(join(outDir, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
  console.log("  deployment.json");

  // Emit source map
  if (allSourceMapEntries.length > 0) {
    const sourceMap = { entries: allSourceMapEntries };
    writeFileSync(join(outDir, "source-map.json"), JSON.stringify(sourceMap, null, 2) + "\n");
    console.log("  source-map.json");
  }

  console.log(`\n${protoRoleCount} protocol role IR(s), ${roleDefCount} role def(s), ${agentCount} agent IR(s), ${schemas.length} message schema(s) → ${outDir}`);

  if (hasErrors) {
    console.error("\nCompilation completed with errors.");
    process.exit(1);
  }
}

// ── main ────────────────────────────────────────────────────────────

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);

  if (!cmd || !file) usage();

  switch (cmd) {
    case "parse":
      cmdParse(file);
      break;
    case "ir":
      cmdIR(file, rest[0]);
      break;
    case "validate":
      cmdValidate(file, rest[0]);
      break;
    case "compile": {
      const outDir = rest[0];
      if (!outDir) {
        console.error("compile requires an output directory: reagent-lang compile <file.rg> <out-dir>");
        process.exit(2);
      }
      cmdCompile(file, outDir);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
  }
}

main();
