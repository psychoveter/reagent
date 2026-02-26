/**
 * Wave 3.1: Self-hosting bootstrap tests.
 *
 * Verifies that ROS creates and manages an internal system RC.
 */

import { ReagentOrchestratorServer } from "../ts/src/ros.js";

const results: Array<{ name: string; pass: boolean; error?: string }> = [];

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    results.push({ name, pass: false, error: err.message ?? String(err) });
    console.log(`  ✗ ${name} — ${err.message ?? err}`);
  }
}

async function main(): Promise<void> {
  console.log("=== Wave 3.1: Self-hosting Bootstrap Tests ===\n");

  await run("SH1: ROS creates system RC on start", async () => {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const rc = ros.getSystemRC();
    if (!rc) throw new Error("System RC is null after start");
    if (typeof port !== "number" || port <= 0) throw new Error(`Invalid port: ${port}`);
    await ros.stop();
  });

  await run("SH2: System RC has ros-system nodeId", async () => {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    await ros.start();
    const rc = ros.getSystemRC();
    if (!rc) throw new Error("System RC is null");
    if ((rc as any).nodeId !== "ros-system") {
      throw new Error(`Expected nodeId 'ros-system', got '${(rc as any).nodeId}'`);
    }
    await ros.stop();
  });

  await run("SH3: System RC cleaned up on stop", async () => {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    await ros.start();
    if (!ros.getSystemRC()) throw new Error("System RC should exist after start");
    await ros.stop();
    if (ros.getSystemRC() !== null) throw new Error("System RC should be null after stop");
  });

  await run("SH4: Multiple start/stop cycles work", async () => {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    await ros.start();
    if (!ros.getSystemRC()) throw new Error("First start: RC missing");
    await ros.stop();
    if (ros.getSystemRC() !== null) throw new Error("After first stop: RC should be null");

    await ros.start();
    if (!ros.getSystemRC()) throw new Error("Second start: RC missing");
    await ros.stop();
    if (ros.getSystemRC() !== null) throw new Error("After second stop: RC should be null");
  });

  console.log(`\n${results.filter(r => r.pass).length} passed, ${results.filter(r => !r.pass).length} failed out of ${results.length}`);
  if (results.some(r => !r.pass)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
