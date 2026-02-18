/**
 * CLI entry point for running a Reagent agent process.
 *
 * Usage:
 *   node main.js --agent <agent-ir.json> --graphs <graph1.json> [<graph2.json> ...] --nats <nats-url> --role-map <deployment.json>
 *
 * Uses NatsCompatTransport to bridge the NATS connection to the ReagentTransport interface.
 */

import { readFileSync } from "node:fs";
import { AgentRunner, type AgentRunnerConfig } from "./agent-runner.js";
import type { AgentIR, IRGraph, DeploymentPlan, ProtocolTrigger } from "./types.js";
import { NatsTransport } from "./nats-transport.js";
import { NatsCompatTransport } from "./nats-compat-transport.js";

function parseArgs(): {
  agentFile: string;
  graphFiles: string[];
  natsUrl: string;
  deploymentFile: string;
} {
  const args = process.argv.slice(2);
  let agentFile = "";
  const graphFiles: string[] = [];
  let natsUrl = "nats://localhost:4222";
  let deploymentFile = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent":
        agentFile = args[++i];
        break;
      case "--graphs":
        while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          graphFiles.push(args[++i]);
        }
        break;
      case "--nats":
        natsUrl = args[++i];
        break;
      case "--role-map":
        deploymentFile = args[++i];
        break;
    }
  }

  if (!agentFile || graphFiles.length === 0 || !deploymentFile) {
    console.error("Usage: main.js --agent <agent.json> --graphs <g1.json> [...] --nats <url> --role-map <deployment.json>");
    process.exit(2);
  }

  return { agentFile, graphFiles, natsUrl, deploymentFile };
}

async function main() {
  const { agentFile, graphFiles, natsUrl, deploymentFile } = parseArgs();

  const agentIR: AgentIR = JSON.parse(readFileSync(agentFile, "utf8"));
  const deployment: DeploymentPlan = JSON.parse(readFileSync(deploymentFile, "utf8"));

  const graphs = new Map<string, IRGraph>();
  for (const gf of graphFiles) {
    const graph: IRGraph = JSON.parse(readFileSync(gf, "utf8"));
    const key = `${graph.protocolName}.${graph.role}`;
    graphs.set(key, graph);
  }

  const nats = new NatsTransport(natsUrl);
  await nats.connect();

  const transport = new NatsCompatTransport(agentIR.agentName, nats);

  const config: AgentRunnerConfig = {
    agentIR,
    graphs,
    transport,
    roleToAgent: deployment.roleToAgent,
  };

  const runner = new AgentRunner(config);

  transport.subscribeTriggers((data) => {
    runner.triggerProtocol(data as ProtocolTrigger);
  });

  await runner.start();

  const shutdown = async () => {
    await runner.stop();
    await nats.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
