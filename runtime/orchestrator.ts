/**
 * Reagent Orchestrator — compiles .rg, launches agents, injects input, collects traces.
 *
 * Usage:
 *   npx tsx orchestrator.ts <file.rg> --input '{"text":"hello"}' [--nats nats://localhost:4222] [--timeout 30000]
 *
 * Steps:
 *   1. Compile .rg → AST → IRGraphs + AgentIRs
 *   2. Write IR to temp fixtures directory
 *   3. Build deployment plan (agent → roles → IRGraph files)
 *   4. Start NATS (or connect to existing)
 *   5. Launch one OS process per agent (TS via node, Python via python3)
 *   6. Subscribe to trace events
 *   7. Inject protocol trigger to initiator agent
 *   8. Wait for completion or timeout
 *   9. Output collected traces
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, StringCodec, type NatsConnection } from "nats";
import { parseProgram } from "../lang/src/parser.js";
import { emitIR, emitAgentIR, resetIdCounter } from "../lang/src/ir-emitter.js";
import type { AgentDef, ProtocolDef } from "../lang/src/ast.js";
import type { AgentIR, IRGraph } from "../lang/src/ir.js";
import { randomUUID } from "node:crypto";

const sc = StringCodec();

// ── Arg parsing ─────────────────────────────────────────────────────

interface OrchestratorArgs {
  rgFile: string;
  input: Record<string, unknown>;
  natsUrl: string;
  timeoutMs: number;
}

function parseArgs(): OrchestratorArgs {
  const args = process.argv.slice(2);
  let rgFile = "";
  let input: Record<string, unknown> = {};
  let natsUrl = "nats://localhost:4222";
  let timeoutMs = 30000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input") {
      input = JSON.parse(args[++i]);
    } else if (args[i] === "--nats") {
      natsUrl = args[++i];
    } else if (args[i] === "--timeout") {
      timeoutMs = parseInt(args[++i], 10);
    } else if (!args[i].startsWith("--")) {
      rgFile = args[i];
    }
  }

  if (!rgFile) {
    console.error("Usage: orchestrator.ts <file.rg> --input '{...}' [--nats url] [--timeout ms]");
    process.exit(2);
  }

  return { rgFile, input, natsUrl, timeoutMs };
}

// ── Compilation ─────────────────────────────────────────────────────

interface CompilationResult {
  protocols: ProtocolDef[];
  agents: AgentDef[];
  graphs: Map<string, IRGraph>; // key: "Proto.role"
  agentIRs: Map<string, AgentIR>; // key: agentName
  roleToAgent: Record<string, string>; // "Proto.role" -> agentName
}

function compile(rgFile: string): CompilationResult {
  const src = readFileSync(rgFile, "utf8");
  const res = parseProgram(src);

  if (!res.ok) {
    console.error("Parse errors:");
    for (const e of res.errors) {
      console.error(`  [${e.code}] ${e.message} at ${e.loc.start.line}:${e.loc.start.col}`);
    }
    process.exit(1);
  }

  const protocols = res.ast.items.filter(
    (i): i is ProtocolDef => i.kind === "ProtocolDef"
  );
  const agents = res.ast.items.filter(
    (i): i is AgentDef => i.kind === "AgentDef"
  );

  const graphs = new Map<string, IRGraph>();
  for (const proto of protocols) {
    resetIdCounter();
    const result = emitIR(proto);
    for (const [role, graph] of result.graphs) {
      graphs.set(`${proto.name}.${role}`, graph);
    }
  }

  const agentIRs = new Map<string, AgentIR>();
  const roleToAgent: Record<string, string> = {};

  for (const agent of agents) {
    const result = emitAgentIR(agent);
    agentIRs.set(agent.name, result.agentIR);
    for (const p of agent.plays) {
      roleToAgent[`${p.protocolName}.${p.roleName}`] = agent.name;
    }
  }

  return { protocols, agents, graphs, agentIRs, roleToAgent };
}

// ── Write fixtures ──────────────────────────────────────────────────

function writeFixtures(
  comp: CompilationResult,
  outDir: string,
): { deploymentFile: string; agentFiles: Map<string, { agentFile: string; graphFiles: string[] }> } {
  mkdirSync(outDir, { recursive: true });

  const agentFiles = new Map<string, { agentFile: string; graphFiles: string[] }>();

  // Write graphs
  for (const [key, graph] of comp.graphs) {
    const path = join(outDir, `${key}.ir.json`);
    writeFileSync(path, JSON.stringify(graph, null, 2));
  }

  // Write agent IRs
  for (const [name, ir] of comp.agentIRs) {
    const path = join(outDir, `${name}.agent.json`);
    writeFileSync(path, JSON.stringify(ir, null, 2));

    const gfiles: string[] = [];
    for (const p of ir.plays) {
      gfiles.push(join(outDir, `${p.protocolName}.${p.roleName}.ir.json`));
    }
    agentFiles.set(name, { agentFile: path, graphFiles: gfiles });
  }

  // Write deployment
  const deployment = {
    agents: Array.from(comp.agentIRs.values()).map(ir => ({
      agentName: ir.agentName,
      lang: ir.lang,
      agentIRFile: `${ir.agentName}.agent.json`,
      roles: ir.plays.map(p => ({
        protocolName: p.protocolName,
        roleName: p.roleName,
        irGraphFile: `${p.protocolName}.${p.roleName}.ir.json`,
      })),
    })),
    roleToAgent: comp.roleToAgent,
  };

  const deploymentFile = join(outDir, "deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));

  return { deploymentFile, agentFiles };
}

// ── Agent launching ─────────────────────────────────────────────────

function launchTsAgent(
  agentFile: string,
  graphFiles: string[],
  natsUrl: string,
  deploymentFile: string,
): ChildProcess {
  const mainJs = resolve(dirname(new URL(import.meta.url).pathname), "ts/dist/main.js");
  const args = [
    mainJs,
    "--agent", agentFile,
    "--graphs", ...graphFiles,
    "--nats", natsUrl,
    "--role-map", deploymentFile,
  ];
  const child = spawn("node", args, { stdio: "pipe" });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[ts] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[ts:err] ${d}`));
  return child;
}

function launchPyAgent(
  agentFile: string,
  graphFiles: string[],
  natsUrl: string,
  deploymentFile: string,
): ChildProcess {
  const pyDir = resolve(dirname(new URL(import.meta.url).pathname), "py");
  const args = [
    "-m", "reagent_runtime",
    "--agent", agentFile,
    "--graphs", ...graphFiles,
    "--nats", natsUrl,
    "--role-map", deploymentFile,
  ];
  const child = spawn("python3", args, { stdio: "pipe", cwd: pyDir });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[py] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[py:err] ${d}`));
  return child;
}

// ── Main ────────────────────────────────────────────────────────────

export interface OrchestratorResult {
  traces: unknown[];
  success: boolean;
}

export async function orchestrate(opts: {
  rgFile: string;
  input: Record<string, unknown>;
  natsUrl: string;
  timeoutMs: number;
}): Promise<OrchestratorResult> {
  const comp = compile(opts.rgFile);

  // Find the initiator protocol and agent
  const proto = comp.protocols[0];
  if (!proto) throw new Error("No protocol found");

  const initiatorRole = proto.initiator;
  const initiatorKey = `${proto.name}.${initiatorRole}`;
  const initiatorAgent = comp.roleToAgent[initiatorKey];
  if (!initiatorAgent) throw new Error(`No agent for initiator role ${initiatorRole}`);

  // Write fixtures to temp dir
  const outDir = join("/tmp", `reagent-run-${Date.now()}`);
  const { deploymentFile, agentFiles } = writeFixtures(comp, outDir);

  // Connect to NATS to collect traces and send trigger
  const nc = await connect({ servers: opts.natsUrl });

  const traces: unknown[] = [];
  const instanceId = randomUUID();

  // Subscribe to trace events
  const traceSub = nc.subscribe("reagent.trace.>");
  (async () => {
    for await (const msg of traceSub) {
      try {
        const te = JSON.parse(sc.decode(msg.data));
        traces.push(te);
      } catch { /* ignore */ }
    }
  })();

  // Launch agent processes
  const children: ChildProcess[] = [];
  for (const [agentName, ir] of comp.agentIRs) {
    const files = agentFiles.get(agentName)!;
    const lang = ir.lang;

    if (lang === "ts" || lang === "js") {
      children.push(launchTsAgent(files.agentFile, files.graphFiles, opts.natsUrl, deploymentFile));
    } else if (lang === "py") {
      children.push(launchPyAgent(files.agentFile, files.graphFiles, opts.natsUrl, deploymentFile));
    } else {
      console.warn(`Unknown language ${lang} for agent ${agentName}, skipping launch`);
    }
  }

  // Give agents time to connect and subscribe
  await new Promise(r => setTimeout(r, 2000));

  // Send trigger to initiator agent
  const trigger = {
    instanceId,
    protocolName: proto.name,
    input: opts.input,
    roleToAgent: comp.roleToAgent,
  };

  nc.publish(
    `reagent.trigger.${initiatorAgent}`,
    sc.encode(JSON.stringify(trigger)),
  );

  // Also trigger non-initiator agents
  for (const [key, agentName] of Object.entries(comp.roleToAgent)) {
    if (agentName !== initiatorAgent) {
      nc.publish(
        `reagent.trigger.${agentName}`,
        sc.encode(JSON.stringify(trigger)),
      );
    }
  }

  // Wait for completion traces or timeout
  const completionPromise = new Promise<void>((resolve) => {
    const expectedCompletions = Object.keys(comp.roleToAgent).length;
    let completed = 0;

    const interval = setInterval(() => {
      const completionTraces = traces.filter(
        (t: any) => t.kind === "ProtocolCompleted" || t.kind === "ProtocolFailed"
      );
      if (completionTraces.length >= expectedCompletions) {
        clearInterval(interval);
        resolve();
      }
    }, 200);

    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, opts.timeoutMs);
  });

  await completionPromise;

  // Small delay to collect any remaining trace events
  await new Promise(r => setTimeout(r, 500));

  // Cleanup
  traceSub.unsubscribe();
  await nc.drain();

  for (const child of children) {
    child.kill("SIGTERM");
  }

  return {
    traces,
    success: traces.some((t: any) => t.kind === "ProtocolCompleted"),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log(`Orchestrating ${args.rgFile}...`);
  console.log(`Input: ${JSON.stringify(args.input)}`);
  console.log(`NATS: ${args.natsUrl}`);
  console.log(`Timeout: ${args.timeoutMs}ms`);

  const result = await orchestrate(args);

  console.log(`\n=== Trace (${result.traces.length} events) ===`);
  for (const t of result.traces) {
    const te = t as any;
    console.log(`  [${te.kind}] agent=${te.agent} role=${te.role} ${te.data ? JSON.stringify(te.data) : ""}`);
  }

  console.log(`\nSuccess: ${result.success}`);
  process.exit(result.success ? 0 : 1);
}

main().catch(err => {
  console.error("Orchestrator fatal:", err);
  process.exit(1);
});
