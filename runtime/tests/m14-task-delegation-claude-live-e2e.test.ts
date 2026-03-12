/**
 * M14 Live E2E: two Claude-based agents participate in TaskDelegation.
 *
 * This test:
 * - builds the task-delegation example
 * - reuses or starts NATS + etcd
 * - launches two live Claude agent runners (human + worker), each with its own mcp-gate
 * - deploys the project through AdminClient
 * - triggers TaskDelegation on HumanAgent
 * - verifies worker-side reasoning and final human-side completion payload
 *
 * Requires:
 * - Docker
 * - ANTHROPIC_API_KEY in env, or projects/reagent/.env, or runtime/agents/claude/.env
 *
 * Run:
 *   cd projects/reagent
 *   runtime/ts/node_modules/.bin/tsx runtime/tests/m14-task-delegation-claude-live-e2e.test.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminClient } from "../ts/src/admin/client.js";
import { NodeControlClient } from "../ts/src/admin/node-control-client.js";
import type { RuntimeConfig } from "../ts/src/cluster/runtime-config.js";
import type { ClaudeLiveAgentNodeConfig } from "../agents/claude/config.js";

type TestResult = { name: string; passed: boolean; error?: string };

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

type AgentLogEvent = {
  ts: string;
  agentName: string;
  kind: string;
  runtimeConfigPath?: string;
  roles?: string[];
  instanceId?: string;
  protocolName?: string;
  role?: string;
  eventType?: string;
  stateId?: string;
  ctx?: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAGENT_ROOT = resolve(__dirname, "..", "..");
const TASK_ROOT = join(REAGENT_ROOT, "examples", "projects", "task-delegation");
const TASK_OUT = join(TASK_ROOT, "out");
const TASK_CONFIG_ROOT = join(TASK_ROOT, "config");
const CLAUDE_AGENT_ROOT = join(REAGENT_ROOT, "runtime", "agents", "claude");
const CLAUDE_AGENT_DIST = join(CLAUDE_AGENT_ROOT, "dist", "live-agent.js");
const MCP_GATE_DIST = join(REAGENT_ROOT, "runtime", "ts", "dist", "mcp-gate.js");
const PROJECT_ENV_PATH = join(REAGENT_ROOT, ".env");
const CLAUDE_ENV_PATH = join(CLAUDE_AGENT_ROOT, ".env");
const HUMAN_NODE_TEMPLATE = join(TASK_CONFIG_ROOT, "human.claude-node.json");
const WORKER_NODE_TEMPLATE = join(TASK_CONFIG_ROOT, "worker.claude-node.docker.json");
const VERBOSE = process.env.REAGENT_TEST_VERBOSE === "1";
type InfraContext = {
  composePath: string;
  natsPort: number;
  natsMonitorPort: number;
  etcdPort: number;
};

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function emitVerbose(line: string): void {
  if (VERBOSE) process.stdout.write(`${line}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseDotEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    // ignore missing .env
  }
  return env;
}

function resolveAnthropicEnv(): Record<string, string> {
  if (process.env.ANTHROPIC_API_KEY) {
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  }
  const projectEnv = parseDotEnv(PROJECT_ENV_PATH);
  if (projectEnv.ANTHROPIC_API_KEY) {
    return { ANTHROPIC_API_KEY: projectEnv.ANTHROPIC_API_KEY };
  }
  const fileEnv = parseDotEnv(CLAUDE_ENV_PATH);
  if (fileEnv.ANTHROPIC_API_KEY) {
    return { ANTHROPIC_API_KEY: fileEnv.ANTHROPIC_API_KEY };
  }
  throw new Error("ANTHROPIC_API_KEY is required for the live Claude E2E test");
}

class EventQueue<T> {
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

  async next(filter: (value: T) => boolean, timeoutMs = 120000): Promise<T> {
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

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timeoutMs = options.timeoutMs ?? 120000;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out running ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command} ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  return { stdout, stderr };
}

async function ensureBuilds(): Promise<void> {
  await runCommand("npm", ["run", "build"], { cwd: join(REAGENT_ROOT, "lang") });
  await runCommand("npm", ["run", "build"], { cwd: join(REAGENT_ROOT, "runtime", "ts") });
  await runCommand("npm", ["run", "build"], { cwd: CLAUDE_AGENT_ROOT });
  await runCommand("node", [join(REAGENT_ROOT, "lang", "dist", "cli.js"), "build", TASK_ROOT], { cwd: REAGENT_ROOT });
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function ensureInfra(tempDir: string): Promise<InfraContext> {
  const natsPort = await getFreePort();
  const natsMonitorPort = await getFreePort();
  const etcdPort = await getFreePort();
  const composePath = join(tempDir, "docker-compose.live.yml");

  writeFileSync(composePath, `services:
  nats:
    image: nats:alpine
    ports:
      - "${natsPort}:4222"
      - "${natsMonitorPort}:8222"
    command: ["--http_port", "8222"]
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1:8222/healthz || exit 1"]
      interval: 3s
      timeout: 2s
      retries: 5
      start_period: 2s

  etcd:
    image: quay.io/coreos/etcd:v3.5.17
    ports:
      - "${etcdPort}:2379"
    command:
      - etcd
      - --advertise-client-urls=http://0.0.0.0:2379
      - --listen-client-urls=http://0.0.0.0:2379
    healthcheck:
      test: ["CMD", "etcdctl", "endpoint", "health"]
      interval: 3s
      timeout: 2s
      retries: 5
`);

  await runCommand("docker", ["compose", "-f", composePath, "up", "-d", "--wait"], {
    cwd: TASK_ROOT,
    timeoutMs: 120000,
  });

  return { composePath, natsPort, natsMonitorPort, etcdPort };
}

async function stopInfra(infra: InfraContext): Promise<void> {
  await runCommand("docker", ["compose", "-f", infra.composePath, "down"], {
    cwd: TASK_ROOT,
    timeoutMs: 120000,
  });
}

function loadDeployPayload(): {
  deployment: DeploymentPlan;
  roleIRs: Record<string, unknown>;
  irGraphs: Record<string, unknown>;
  sourceMap: { entries: Array<Record<string, unknown>> };
} {
  const deployment = readJson<DeploymentPlan>(join(TASK_OUT, "deployment.json"));
  const sourceMap = readJson<{ entries: Array<Record<string, unknown>> }>(join(TASK_OUT, "source-map.json"));
  const roleIRs = Object.fromEntries(
    deployment.agents.map((agentDef) => [
      agentDef.roleName,
      readJson(join(TASK_OUT, agentDef.roleIRFile)),
    ]),
  );
  const irGraphs = Object.fromEntries(
    deployment.agents.flatMap((agentDef) =>
      agentDef.roles.map((binding) => [
        `${binding.protocolName}.${binding.roleName}`,
        readJson(join(TASK_OUT, binding.irGraphFile)),
      ]),
    ),
  );
  return { deployment, roleIRs, irGraphs, sourceMap };
}

function materializeClaudeNodeConfig(
  templatePath: string,
  outputPath: string,
  overrides: {
    nodeId: string;
    etcdUrl: string;
    natsUrl: string;
    controlHost: string;
    controlPort: number;
    advertiseUrl: string;
  },
): string {
  const config = readJson<ClaudeLiveAgentNodeConfig<RuntimeConfig>>(templatePath);
  const runtime = config.runtime;
  const materialized: ClaudeLiveAgentNodeConfig<RuntimeConfig> = {
    ...config,
    runtime: {
      ...runtime,
      nodeId: overrides.nodeId,
      stateStore: runtime.stateStore.kind === "etcd"
      ? { kind: "etcd", hosts: [overrides.etcdUrl] }
      : runtime.stateStore,
      messagePlane: runtime.messagePlane?.kind === "nats"
      ? { kind: "nats", url: overrides.natsUrl }
      : runtime.messagePlane,
      controlEndpoint: {
        ...runtime.controlEndpoint,
        enabled: true,
        host: overrides.controlHost,
        port: overrides.controlPort,
        advertiseUrl: overrides.advertiseUrl,
      },
    },
  };
  writeFileSync(outputPath, JSON.stringify(materialized, null, 2));
  return outputPath;
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function withLiveAgents<T>(fn: (ctx: {
  admin: AdminClient;
  humanEvents: EventQueue<AgentLogEvent>;
  workerEvents: EventQueue<AgentLogEvent>;
  humanNodeUrl: string;
  workerNodeUrl: string;
  logs: string[];
}) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const anthropicEnv = resolveAnthropicEnv();
  const tempDir = mkdtempSync(join(tmpdir(), "task-delegation-live-"));
  const infra = await ensureInfra(tempDir);
  const humanControlPort = await getFreePort();
  const workerControlPort = await getFreePort();
  const humanNodeId = `human-gate-${Date.now()}`;
  const workerNodeId = `worker-gate-${Date.now()}`;
  const humanConfig = materializeClaudeNodeConfig(
    HUMAN_NODE_TEMPLATE,
    join(tempDir, `${humanNodeId}.claude-node.json`),
    {
      nodeId: humanNodeId,
      etcdUrl: `http://127.0.0.1:${infra.etcdPort}`,
      natsUrl: `nats://127.0.0.1:${infra.natsPort}`,
      controlHost: "127.0.0.1",
      controlPort: humanControlPort,
      advertiseUrl: `ws://127.0.0.1:${humanControlPort}`,
    },
  );
  const workerConfig = materializeClaudeNodeConfig(
    WORKER_NODE_TEMPLATE,
    join(tempDir, `${workerNodeId}.claude-node.json`),
    {
      nodeId: workerNodeId,
      etcdUrl: `http://127.0.0.1:${infra.etcdPort}`,
      natsUrl: `nats://127.0.0.1:${infra.natsPort}`,
      controlHost: "127.0.0.1",
      controlPort: workerControlPort,
      advertiseUrl: `ws://127.0.0.1:${workerControlPort}`,
    },
  );
  const humanNodeUrl = `ws://127.0.0.1:${humanControlPort}`;
  const workerNodeUrl = `ws://127.0.0.1:${workerControlPort}`;

  const humanEvents = new EventQueue<AgentLogEvent>();
  const workerEvents = new EventQueue<AgentLogEvent>();

  const spawnLiveAgent = (
    name: string,
    nodeConfigPath: string,
    queue: EventQueue<AgentLogEvent>,
  ) => {
    const child = spawn("node", [CLAUDE_AGENT_DIST], {
      cwd: CLAUDE_AGENT_ROOT,
      env: {
        ...process.env,
        ...anthropicEnv,
        CLAUDE_NODE_CONFIG: nodeConfigPath,
        MCP_GATE_PATH: MCP_GATE_DIST,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rendered = `[${name}:stdout] ${line}`;
        logs.push(rendered);
        emitVerbose(rendered);
        try {
          queue.push(JSON.parse(line) as AgentLogEvent);
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rendered = `[${name}:stderr] ${line}`;
        logs.push(rendered);
        emitVerbose(rendered);
      }
    });

    child.once("exit", (code) => {
      const rendered = `[${name}:exit] ${code}`;
      logs.push(rendered);
      emitVerbose(rendered);
    });

    return child;
  };

  const human = spawnLiveAgent(
    "HumanAgent",
    humanConfig,
    humanEvents,
  );
  const worker = spawnLiveAgent(
    "WorkerAgent",
    workerConfig,
    workerEvents,
  );

  const admin = AdminClient.fromStateStoreConfig({ kind: "etcd", hosts: [`http://127.0.0.1:${infra.etcdPort}`] });

  try {
    await humanEvents.next((event) => event.kind === "registered", 120000);
    await workerEvents.next((event) => event.kind === "registered", 120000);

    await waitFor(async () => {
      const status = await admin.clusterStatus();
      const nodes = (status.payload.nodes as Array<Record<string, unknown>> | undefined) ?? [];
      return nodes.length >= 2;
    }, 60000, 1000, "two cluster nodes");

    return await fn({ admin, humanEvents, workerEvents, humanNodeUrl, workerNodeUrl, logs });
  } catch (err) {
    throw new Error(`${String(err)}\n--- live agent logs ---\n${logs.slice(-120).join("\n")}`);
  } finally {
    if (human.exitCode === null) human.kill("SIGTERM");
    if (worker.exitCode === null) worker.kill("SIGTERM");
    try {
      await waitForChildExit(human);
    } catch {
      human.kill("SIGKILL");
    }
    try {
      await waitForChildExit(worker);
    } catch {
      worker.kill("SIGKILL");
    }
    await stopInfra(infra);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testT44(): Promise<TestResult> {
  const name = "T44: two live Claude agents complete task delegation";
  try {
    await ensureBuilds();
    await withLiveAgents(async ({ admin, humanEvents, workerEvents, humanNodeUrl, workerNodeUrl, logs }) => {
      const deploy = loadDeployPayload();
      const humanNode = new NodeControlClient(humanNodeUrl);
      const workerNode = new NodeControlClient(workerNodeUrl);
      try {
        const humanDeployment = {
          ...deploy.deployment,
          agents: deploy.deployment.agents.filter((agent) => agent.agentName === "HumanAgent"),
        };
        const workerDeployment = {
          ...deploy.deployment,
          agents: deploy.deployment.agents.filter((agent) => agent.agentName === "WorkerAgent"),
        };

        const humanDeploy = await humanNode.request("DeployProject", {
          deployment: humanDeployment,
          roleIRs: deploy.roleIRs,
          irGraphs: deploy.irGraphs,
          sourceMap: deploy.sourceMap,
          projectVersion: "0.1.0",
        });
        const workerDeploy = await workerNode.request("DeployProject", {
          deployment: workerDeployment,
          roleIRs: deploy.roleIRs,
          irGraphs: deploy.irGraphs,
          sourceMap: deploy.sourceMap,
          projectVersion: "0.1.0",
        });
        assert(((humanDeploy.deployedAgents as string[]) ?? []).includes("HumanAgent"), "human node should deploy HumanAgent");
        assert(((workerDeploy.deployedAgents as string[]) ?? []).includes("WorkerAgent"), "worker node should deploy WorkerAgent");

        await waitFor(async () => {
          const listed = await humanNode.request("StoreList", { prefix: "/agents/" });
          const entries = (listed.entries as Array<{ key?: string; value?: string }> | undefined) ?? [];
          const names = new Set(
            entries
              .map((entry) => String(entry.key ?? "").replace("/agents/", ""))
              .filter(Boolean),
          );
          return names.has("HumanAgent") && names.has("WorkerAgent");
        }, 30000, 1000, "HumanAgent and WorkerAgent registrations");

        const trigger = await humanNode.request("TriggerProtocol", {
          agentName: "HumanAgent",
          protocolName: "TaskDelegation",
          input: {
            description: "Summarize why deterministic e2e tests are useful for protocol debugging.",
            context: {
              repository: "reagent",
              format: "Provide a short answer and a rationale",
            },
          },
          roleToAgent: deploy.deployment.roleToAgent,
        });
        const instanceId = String(trigger.instanceId ?? "");
        assert(instanceId.length > 0, "trigger should return instanceId");

        const workerAction = await workerEvents.next(
          (event) =>
            event.kind === "response" &&
            event.instanceId === instanceId &&
            event.eventType === "action",
          180000,
        );
        const workerCtx = (workerAction.response?.ctx ?? {}) as Record<string, unknown>;
        assert(typeof workerCtx.workSummary === "string" && workerCtx.workSummary.length > 0, "worker should produce a workSummary");

        const humanComplete = await humanEvents.next(
          (event) =>
            event.kind === "lifecycle" &&
            event.instanceId === instanceId &&
            event.eventType === "protocol_completed",
          180000,
        );
        const ctx = (humanComplete.ctx ?? {}) as Record<string, unknown>;
        const review = (ctx.review ?? {}) as Record<string, unknown>;
        assert(review.accepted === true, "human should accept the worker result");
        assert(typeof review.summary === "string" && review.summary.length > 0, "review summary should be non-empty");
        assert(typeof review.result === "object" && review.result !== null, "review result should be structured");

        const humanParticipated = logs.some((line) => line.includes("\"kind\":\"response\"") && line.includes("\"agentName\":\"HumanAgent\""));
        assert(humanParticipated, "human agent should emit at least one response event");
      } finally {
        humanNode.close();
        workerNode.close();
      }
    });

    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  console.log("=== M14 Task Delegation Claude Live E2E ===\n");
  const result = await testT44();
  if (result.passed) {
    console.log(`  ✓ ${result.name}`);
    console.log("\n1 passed, 0 failed out of 1");
    return;
  }
  console.error(`  ✗ ${result.name}\n    ${result.error}`);
  console.log("\n0 passed, 1 failed out of 1");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
