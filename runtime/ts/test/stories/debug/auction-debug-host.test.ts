/**
 * M13 Debug E2E: single-node auction-sim debug flow through NodeControlClient.
 *
 * No VSIX/extension involved:
 * - start the real auction-sim node host as a subprocess
 * - deploy compiled artifacts over the node control endpoint
 * - drive debug sessions through NodeControlClient
 *
 * Run:
 *   cd projects/reagent
 *   runtime/ts/node_modules/.bin/tsx runtime/ts/test/stories/debug/auction-debug-host.test.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { NodeControlClient } from "../../../src/admin/node-control-client.js";
import { exitForSeriesResults, failSeriesRun, type TestResult } from "../../support/test-output.js";

type DeploymentPlan = {
  agents: Array<{
    agentName: string;
    lang: string;
    roleName: string;
    roleIRFile: string;
    roles: Array<{ protocolName: string; roleName: string; irGraphFile: string }>;
  }>;
  roleToAgent: Record<string, string | string[]>;
};

type SourceMapEntry = {
  stateId: string;
  protocolName: string;
  role: string;
  file: string;
  line: number;
  column: number;
};

type StoppedEvent = {
  sessionId: string;
  stateId: string;
  stateKind: string;
  agentName: string;
  instanceId: string;
  protocolName: string;
  roleName: string;
  reason: "breakpoint" | "step";
  ctx: Record<string, unknown>;
  self: Record<string, unknown>;
};

type TraceEventPayload = {
  kind: string;
  instanceId?: string;
  agentName?: string;
  role?: string;
  data?: Record<string, unknown>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = runtime/ts/test/stories/debug → 5× ".." reaches the reagent root.
const REAGENT_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const AUCTION_SIM_ROOT = join(REAGENT_ROOT, "examples", "projects", "auction-sim");
const AUCTION_SIM_OUT = join(AUCTION_SIM_ROOT, "out");
const TSX_BIN = join(REAGENT_ROOT, "runtime", "ts", "node_modules", ".bin", "tsx");

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadDeployPayload(): {
  deployment: DeploymentPlan;
  roleIRs: Record<string, unknown>;
  irGraphs: Record<string, unknown>;
  sourceMap: { entries: SourceMapEntry[] };
} {
  const deployment = readJson<DeploymentPlan>(join(AUCTION_SIM_OUT, "deployment.json"));
  const sourceMap = readJson<{ entries: SourceMapEntry[] }>(join(AUCTION_SIM_OUT, "source-map.json"));
  const roleIRs = Object.fromEntries(
    deployment.agents.map((agentDef) => [
      agentDef.roleName,
      readJson(join(AUCTION_SIM_OUT, agentDef.roleIRFile)),
    ]),
  );
  const irGraphs = Object.fromEntries(
    deployment.agents.flatMap((agentDef) =>
      agentDef.roles.map((binding) => [
        `${binding.protocolName}.${binding.roleName}`,
        readJson(join(AUCTION_SIM_OUT, binding.irGraphFile)),
      ]),
    ),
  );
  return { deployment, roleIRs, irGraphs, sourceMap };
}

function resolveStateId(sourceMap: { entries: SourceMapEntry[] }, role: string, line: number): string {
  const entry = sourceMap.entries.find((candidate) =>
    candidate.protocolName === "Auction" &&
    candidate.role === role &&
    candidate.line === line,
  );
  if (!entry) {
    throw new Error(`No source-map state for role=${role} line=${line}`);
  }
  return entry.stateId;
}

function summarizeTrace(events: TraceEventPayload[], instanceId: string): string {
  const relevant = events
    .filter((event) => event.instanceId === instanceId)
    .slice(-20)
    .map((event) => {
      const stateId = String(event.data?.stateId ?? "");
      const zone = String(event.data?.zone ?? "");
      return [event.kind, event.role ?? "", stateId, zone].filter(Boolean).join(":");
    });
  return relevant.length > 0 ? relevant.join(" | ") : "(no trace events captured)";
}

class EventQueue<T extends Record<string, unknown>> {
  private queue: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.queue.push(value);
  }

  async next(filter: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
    const existingIdx = this.queue.findIndex(filter);
    if (existingIdx >= 0) {
      return this.queue.splice(existingIdx, 1)[0];
    }

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for event after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter = (value: T) => {
        if (!filter(value)) {
          this.queue.push(value);
          this.waiters.push(waiter);
          return;
        }
        clearTimeout(timeout);
        resolve(value);
      };

      this.waiters.push(waiter);
    });
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child process exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withAuctionNode<T>(fn: (ctx: {
  client: NodeControlClient;
  sourceMap: { entries: SourceMapEntry[] };
  logs: string[];
}) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const tempDir = mkdtempSync(join(tmpdir(), "auction-debug-e2e-"));
  const runtimeConfigPath = join(tempDir, "runtime.json");
  writeFileSync(runtimeConfigPath, JSON.stringify({
    nodeId: `auction-e2e-${Date.now()}`,
    langs: ["ts"],
    stateStore: { kind: "memory" },
    membership: { enabled: false },
    messagePlane: { kind: "none" },
    telemetry: { traceSink: "none", interceptors: [] },
    controlEndpoint: { enabled: true, host: "127.0.0.1", port: 0 },
    triggerPolicies: {},
    cronIntervalMs: 15000,
  }, null, 2));

  const child = spawn(TSX_BIN, [
    join(AUCTION_SIM_ROOT, "run_node.ts"),
    "--runtime-config",
    runtimeConfigPath,
  ], {
    cwd: AUCTION_SIM_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let endpointUrl = "";
  const endpointReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out starting auction node.\n${logs.join("\n")}`)), 10000);
    const onLine = (line: string) => {
      logs.push(line);
      const match = line.match(/control endpoint listening at (ws:\/\/\S+)/);
      if (match) {
        endpointUrl = match[1];
        clearTimeout(timer);
        resolve();
      }
    };

    child.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) logs.push(`[stderr] ${line}`);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Auction node exited early with code ${code}.\n${logs.join("\n")}`));
    });
  });

  let client: NodeControlClient | null = null;
  try {
    await endpointReady;
    client = new NodeControlClient(endpointUrl);
    await client.connect();

    const deploy = loadDeployPayload();
    const deployResult = await client.request("DeployProject", {
      deployment: deploy.deployment,
      roleIRs: deploy.roleIRs,
      irGraphs: deploy.irGraphs,
      sourceMap: deploy.sourceMap,
      projectVersion: "0.1.0",
    });
    const deployedAgents = (deployResult.deployedAgents as string[]) ?? [];
    assert(deployedAgents.length === 4, "deploy should register four auction agents");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

    try {
      return await fn({
        client,
        sourceMap: deploy.sourceMap,
        logs,
      });
    } catch (err) {
      const details = logs.slice(-20).join("\n");
      throw new Error(`${String(err)}\n--- auction node logs ---\n${details}`);
    }
  } finally {
    try {
      client?.close();
    } catch {
      // ignore
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    try {
      await waitForChildExit(child);
    } catch {
      child.kill("SIGKILL");
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testT41(): Promise<TestResult> {
  const name = "T41: step commands drive auction-sim into the scatter fork";
  try {
    await withAuctionNode(async ({ client, sourceMap }) => {
      const stopped = new EventQueue<StoppedEvent>();
      const sessionId = "auction-step-session";
      const sellerAction = resolveStateId(sourceMap, "seller", 37);
      const sellerSendIntoScatter = resolveStateId(sourceMap, "seller", 47);
      const scatterStateIds = new Set([
        "scatter_fork_3",
        sellerSendIntoScatter,
        resolveStateId(sourceMap, "seller", 65),
        resolveStateId(sourceMap, "buyer", 47),
        resolveStateId(sourceMap, "buyer", 58),
        resolveStateId(sourceMap, "buyer", 65),
      ]);
      const dispose = client.on("Stopped", (payload) => stopped.push(payload as unknown as StoppedEvent));
      try {
        await client.request("TriggerProtocol", {
          agentName: "Auctioneer",
          protocolName: "Auction",
          input: { itemName: "Debug Vase", reservePrice: 120 },
          mode: "debug",
          sessionId,
        });

        const first = await stopped.next((event) => event.sessionId === sessionId);
        assert(first.stateKind === "initial", "first stop should be the initial state");
        assert(first.roleName === "seller", "seller should own the initial stop");

        await client.request("DebugCommand", { sessionId, command: "stepState" });
        const second = await stopped.next((event) => event.sessionId === sessionId);
        assert(second.stateId === sellerAction, "stepState should move into the seller action before scatter");

        await client.request("DebugCommand", {
          sessionId,
          command: "stepIntoScatter",
          branchIndex: 0,
        });

        const third = await stopped.next((event) => event.sessionId === sessionId);
        assert(
          scatterStateIds.has(third.stateId),
          `stepIntoScatter should stop inside the scatter branch, got ${third.stateId} (${third.roleName}/${third.stateKind})`,
        );
        assert(third.reason === "step", "scatter entry should be a step stop");

        const stepOutAck = await client.request("DebugCommand", {
          sessionId,
          command: "stepOutScatter",
        });
        assert(stepOutAck.acknowledged === true, "stepOutScatter command should be acknowledged");

        await client.request("DebugCommand", { sessionId, command: "stop" });
      } finally {
        dispose();
      }
    });

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

async function testT42(): Promise<TestResult> {
  const name = "T42: breakpoint install and update works through the node control client";
  try {
    await withAuctionNode(async ({ client, sourceMap }) => {
      const stopped = new EventQueue<StoppedEvent>();
      const sessionId = "auction-breakpoint-session";
      const sellerAction = resolveStateId(sourceMap, "seller", 37);
      const scatterFork = "scatter_fork_3";
      const dispose = client.on("Stopped", (payload) => stopped.push(payload as unknown as StoppedEvent));
      try {
        await client.request("TriggerProtocol", {
          agentName: "Auctioneer",
          protocolName: "Auction",
          input: { itemName: "Breakpoint Vase", reservePrice: 140 },
          mode: "debug",
          sessionId,
          breakpoints: [sellerAction],
        });

        const first = await stopped.next((event) => event.sessionId === sessionId, 15000);
        assert(first.stateId === sellerAction, `debug session should stop on the configured breakpoint, got ${first.stateId}`);
        assert(first.reason === "breakpoint", "configured state should stop as a breakpoint");

        await client.request("DebugCommand", {
          sessionId,
          command: "setBreakpoints",
          breakpoints: [scatterFork],
        });

        await client.request("DebugCommand", { sessionId, command: "continue" });
        const second = await stopped.next((event) => event.sessionId === sessionId, 15000);
        assert(second.stateId === scatterFork, `updated breakpoint should be hit after continue, got ${second.stateId}`);
        assert(second.reason === "breakpoint", "updated stop should still be breakpoint-driven");

        await client.request("DebugCommand", { sessionId, command: "stop" });
      } finally {
        dispose();
      }
    });

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

async function testT43(): Promise<TestResult> {
  const name = "T43: final seller breakpoint at line 110 stops and resumes cleanly";
  try {
    await withAuctionNode(async ({ client, sourceMap }) => {
      const stopped = new EventQueue<StoppedEvent>();
      const trace = new EventQueue<TraceEventPayload>();
      const sessionId = "auction-final-breakpoint-session";
      const finalSellerAction = resolveStateId(sourceMap, "seller", 110);
      const traceEvents: TraceEventPayload[] = [];
      const stopDispose = client.on("Stopped", (payload) => stopped.push(payload as unknown as StoppedEvent));
      const traceDispose = client.on("TraceEvent", (payload) => {
        const event = payload as unknown as TraceEventPayload;
        traceEvents.push(event);
        trace.push(event);
      });
      try {
        const trigger = await client.request("TriggerProtocol", {
          agentName: "Auctioneer",
          protocolName: "Auction",
          input: { itemName: "Final Breakpoint Vase", reservePrice: 140 },
          mode: "debug",
          sessionId,
          breakpoints: [finalSellerAction],
        });

        const instanceId = String(trigger.instanceId ?? "");
        assert(instanceId.length > 0, "trigger should return an instanceId");

        let finalStop: StoppedEvent;
        try {
          finalStop = await stopped.next((event) => event.sessionId === sessionId, 15000);
        } catch (err) {
          throw new Error(`${String(err)}\ntrace=${summarizeTrace(traceEvents, instanceId)}`);
        }
        assert(
          finalStop.stateId === finalSellerAction,
          `final breakpoint should stop at ${finalSellerAction}, got ${finalStop.stateId}`,
        );
        assert(finalStop.reason === "breakpoint", "final seller action should stop because of breakpoint");

        await client.request("DebugCommand", { sessionId, command: "continue" });

        const completed = await trace.next((event) =>
          event.instanceId === instanceId && event.kind === "ProtocolCompleted",
        15000);
        assert(completed.kind === "ProtocolCompleted", "protocol should complete after continuing from final breakpoint");

        const seenStateIds = traceEvents
          .filter((event) => event.instanceId === instanceId)
          .map((event) => String(event.data?.stateId ?? ""))
          .filter(Boolean);
        assert(seenStateIds.includes("send_12"), "trace should reach the second seller scatter send before the final breakpoint");

        await client.request("DebugCommand", { sessionId, command: "stop" });
      } finally {
        stopDispose();
        traceDispose();
      }
    });

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  console.log("=== M13 Debug Auction E2E Tests ===\n");

  const results = [
    await testT41(),
    await testT42(),
    await testT43(),
  ];

  exitForSeriesResults(results);
}

main().catch((err) => {
  failSeriesRun(err);
});
