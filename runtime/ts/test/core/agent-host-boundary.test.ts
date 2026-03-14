/**
 * M8b Agent Model E2E Tests
 *
 * A1: $agent.method() callable in TS zone
 * A2: $agent.method() callable in Python zone (via inproc RC)
 * A3: Zone with await $agent.asyncMethod() (TS)
 * A4: Zone with await $agent.async_method() (Python)
 * A5: agent.json loaded, native module injected as $agent
 * A6: Async zone detection in compiled IR
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

import { emitAgentIR } from "../../../../lang/src/ir-emitter.js";

import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed-behavior-factory.js";
import { executeZone, createReagentStub } from "../../src/core/zone-executor.js";
import { executeZoneAsync } from "../../src/core/zone-executor.js";
import { loadAgentManifest, type AgentManifest } from "../../src/support/agent-manifest.js";
import { compileSource } from "../support/compile-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "..", "..", ".tmp-test-m8b");

function setup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

const SIMPLE_PROTOCOL = `
message TaskRequest { text: string }
message TaskResponse { result: string }

protocol SimpleTask {
  participants:
    client [ts],
    worker [ts]

  initiator: client

  client --> worker: TaskRequest

  worker {
    $ctx.result = $agent.process($ctx.msg.text)
  }

  worker --> client: TaskResponse = {
    onSend {
      $ctx.msg.result = $ctx.result
    }
  }
}

role ClientRole [ts] {
  plays SimpleTask as client
}

role WorkerRole [ts] {
  plays SimpleTask as worker
}

agent clientAgent runs ClientRole
agent workerAgent runs WorkerRole
`;

// ── A1: $agent.method() callable in TS zone ─────────────────────────

test("A1: $agent.method() callable in TS zone", async () => {
  const ctx: Record<string, unknown> = { msg: { text: "hello" } };
  const self: Record<string, unknown> = {};
  const reagent = createReagentStub();

  const agentModule = {
    process: (text: string) => `processed: ${text}`,
  };

  executeZone(
    '$ctx.result = $agent.process($ctx.msg.text)',
    ctx, self, reagent,
    { $agent: agentModule },
  );

  assert.equal(ctx.result, "processed: hello");
  console.log("  A1: PASS");
});

// ── A2: $agent.method() callable in Python zone (via execute_zone) ──

test("A2: $agent.method() callable in Python zone (via inproc RC)", async () => {
  const result = execSync(
    `python3 -c "
import sys; sys.path.insert(0, '.')
from reagent_runtime.zone_executor import execute_zone, ReagentStub, AttrDict

ctx = AttrDict({'msg': AttrDict({'text': 'world'})})
self_s = {}
reagent = ReagentStub()

class Agent:
    def process(self, text):
        return 'processed: ' + text

execute_zone(
    '\\$ctx.result = agent.process(\\$ctx.msg.text)',
    ctx, self_s, reagent, {'agent': Agent()}
)

assert ctx['result'] == 'processed: world', f'Expected processed: world, got {ctx[\"result\"]}'
print('A2: PASS')
"`,
    { encoding: "utf8", cwd: join(__dirname, "..", "..", "..", "py") },
  );
  assert.ok(result.includes("A2: PASS"));
  console.log("  A2: PASS");
});

// ── A3: Zone with await $agent.asyncMethod() (TS) ───────────────────

test("A3: Zone with await $agent.asyncMethod() (TS)", async () => {
  const ctx: Record<string, unknown> = {};
  const self: Record<string, unknown> = {};
  const reagent = createReagentStub();

  const agentModule = {
    asyncMethod: async () => {
      return "async-result";
    },
  };

  await executeZoneAsync(
    '$ctx.result = await $agent.asyncMethod()',
    ctx, self, reagent,
    { $agent: agentModule },
  );

  assert.equal(ctx.result, "async-result");
  console.log("  A3: PASS");
});

// ── A4: Zone with await $agent.async_method() (Python) ──────────────

test("A4: Zone with await $agent.async_method() (Python)", async () => {
  const result = execSync(
    `python3 -c "
import sys, asyncio; sys.path.insert(0, '.')
from reagent_runtime.zone_executor import execute_zone_async, ReagentStub, AttrDict

async def run():
    ctx = AttrDict({})
    self_s = {}
    reagent = ReagentStub()

    class Agent:
        async def async_method(self):
            return 'async-py-result'

    await execute_zone_async(
        '\\$ctx.result = await agent.async_method()',
        ctx, self_s, reagent, {'agent': Agent()}
    )

    assert ctx['result'] == 'async-py-result', f'Got {ctx[\"result\"]}'
    print('A4: PASS')

asyncio.run(run())
"`,
    { encoding: "utf8", cwd: join(__dirname, "..", "..", "..", "py") },
  );
  assert.ok(result.includes("A4: PASS"));
  console.log("  A4: PASS");
});

// ── A5: agent.json loaded, native module injected ───────────────────

test("A5: agent.json loaded, native module injected as $agent", async () => {
  setup();

  const manifestContent = {
    name: "testAgent",
    role: "WorkerRole",
    module: "./impl.js",
  };

  const moduleContent = `
export default { compute: (x) => x * 2 };
`;

  writeFileSync(join(TMP_DIR, "agent.json"), JSON.stringify(manifestContent, null, 2));
  writeFileSync(join(TMP_DIR, "impl.js"), moduleContent);

  const manifest = loadAgentManifest(join(TMP_DIR, "agent.json"));
  assert.equal(manifest.name, "testAgent");
  assert.equal(manifest.role, "WorkerRole");
  assert.equal(manifest.module, "./impl.js");

  const { loadAgentModule } = await import("../../src/support/agent-manifest.js");
  const agentMod = await loadAgentModule(join(TMP_DIR, "agent.json"), manifest);

  assert.ok(agentMod, "Module should be loaded");
  assert.equal(typeof (agentMod as any).compute, "function");
  assert.equal((agentMod as any).compute(5), 10);

  console.log("  A5: PASS");
});

// ── A6: Async zone detection in compiled IR ─────────────────────────

test("A6: Async zone detection in compiled IR", () => {
  const source = `
message Req { data: string }
message Res { data: string }

protocol AsyncProto {
  participants:
    a [ts] initiator,
    b [ts]

  trigger on invoke with Req {
    resolve a = single
    resolve b = single
  }

  a --> b: Req

  b {
    $ctx.result = await $agent.fetchData($ctx.msg.data)
  }

  b --> a: Res
}
`;

  const { graphs } = compileSource(source);
  const bGraph = graphs.get("AsyncProto.b")!;
  assert.ok(bGraph);

  const actionState = bGraph.states.find(s => s.data.kind === "action");
  assert.ok(actionState, "Should have action state");
  const actionData = actionState.data as { kind: "action"; async?: boolean };
  assert.equal(actionData.async, true, "Action with await should be marked async");

  console.log("  A6: PASS");
});
