/**
 * ROS CLI — starts the Reagent Orchestrator Server.
 *
 * Usage: npx tsx runtime/ts/src/ros-cli.ts [--port 18789]
 */

import { ReagentOrchestratorServer } from "./ros.js";

const args = process.argv.slice(2);
let port = 18789;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
}

const ros = new ReagentOrchestratorServer({ port });
const actualPort = await ros.start();

console.log(`[ROS] Reagent Orchestrator Server listening on port ${actualPort}`);

process.on("SIGINT", async () => {
  console.log("\n[ROS] Shutting down...");
  await ros.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await ros.stop();
  process.exit(0);
});
