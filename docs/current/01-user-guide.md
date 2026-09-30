# Reagent User Guide

How to author, build, run, debug, and deploy Reagent projects on the
TypeScript Reagent Controller (RC).

This document is the **entry point** for runtime users. For deeper material
follow the pointers in [`00-registry.md`](00-registry.md): language spec
([`02-lang-spec.md`](02-lang-spec.md)), runtime core
([`03-runtime-core.md`](03-runtime-core.md)), cluster and control plane
([`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md)),
versioning and reconcile ([`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md)),
tooling ([`06-tooling-overview.md`](06-tooling-overview.md)), tests
([`08-test-spec.md`](08-test-spec.md)).

---

## 1. Status At A Glance

- **TypeScript RC is the only first-class runtime today.** Build (`@reagent/lang`),
  runtime (`@reagent/agent-runtime`), debug, deploy, MCP gate, and Claude
  live-agent host all live in TypeScript.
- **`[py]` zone bodies are still supported** via the in-tree zone executor at
  [`runtime/ts/zone-execs/py/`](../../runtime/ts/zone-execs/py/). This is
  language-level scaffolding for the RC's virtual host languages, not a
  parallel runtime.
- **Whole-agent dispatch to `Role[py]`** (i.e. `agent X runs Role[py]`) is
  deferred until the future Rust Release Candidate ships with a PyO3 /
  equivalent host. Tracking: [`docs/future/retire-python-runtime.md`](../future/retire-python-runtime.md).
- **Language tags `[ts]`, `[js]`, `[py]`, `[kt]`, `[*]`** remain part of the
  language surface and IR.

---

## 2. Prerequisites

| Tool | Purpose |
|------|---------|
| **Cursor / VSCode** | IDE with the Reagent extension |
| **Node.js ≥ 18** | Reagent compiler (`@reagent/lang`) and TypeScript runtime |
| **Python ≥ 3.10** | Optional — only when your protocols use `[py]`-tagged zones; executed by the helper under `runtime/ts/zone-execs/py/` |
| **Reagent VSIX** | Syntax highlighting, diagrams, run/debug, LSP |

### Install the extension

```bash
cd projects/reagent/tools/reagent-vscode
npm run package
cursor --install-extension reagent-vscode-*.vsix --force
```

(Use `code --install-extension` instead of `cursor` for vanilla VSCode.)

---

## 3. Quick Start

Five steps from zero to a running protocol.

### 3.1 Scaffold a project

```bash
node lang/dist/cli.js init my-project
cd my-project
```

This creates `reagent.json`, `protocols/`, and `agents/` directories.

### 3.2 Write a tiny protocol

`protocols/hello.rg`:

```
message Greeting { text: string }
message Reply    { text: string }

protocol HelloWorld {
  participants: alice [ts] initiator, bob [ts]
  trigger on invoke with Greeting { resolve alice = single; resolve bob = single }

  alice --> bob: Greeting = {
    onReceive { $self.received = $ctx.msg.text }
  }

  bob --> alice: Reply = {
    onSend    { $ctx.msg.text = "Hello back!" }
    onReceive { $self.reply = $ctx.msg.text }
  }
}

role AliceRole [ts] { plays HelloWorld as alice }
role BobRole   [ts] { plays HelloWorld as bob }

agent Alice runs AliceRole
agent Bob   runs BobRole
```

### 3.3 Build

```bash
node ../lang/dist/cli.js build .
```

Produces compiled IR plus deployment metadata under `out/` (see §7.2).

### 3.4 Run via the IDE

Open `protocols/hello.rg` in Cursor/VSCode. Click the **▶ play button** in the
editor title bar — output appears in the **Reagent Run** output channel.

### 3.5 Iterate

Edit the `.rg` (or any agent native module) and re-run. The IDE re-compiles
on every run. From the CLI, rebuild with `reagent build .` before re-running
a long-lived process.

---

## 4. Project Layout

A Reagent project is a directory with a `reagent.json` manifest:

```
my-project/
├── reagent.json          # project manifest
├── protocols/
│   └── my-protocol.rg    # protocol definitions
├── agents/
│   ├── alice/
│   │   ├── agent.json    # agent manifest (optional)
│   │   └── impl.ts       # $agent native module (optional)
│   └── bob/
│       ├── agent.json
│       └── impl.ts
└── out/                  # compiled IR (generated)
```

### 4.1 `reagent.json`

```json
{
  "name": "my-project",
  "version": "0.0.1",
  "protocols": ["protocols/**/*.rg"],
  "agents": ["agents/*/agent.json"]
}
```

`agents` is optional. Inline `agent X runs Y` declarations inside `.rg` files
work without per-agent folders; per-agent manifests are needed when you
want a native module or static config.

### 4.2 `agent.json`

```json
{
  "name": "Alice",
  "role": "AliceRole",
  "module": "./impl.ts",
  "config": { "maxPrice": 500 }
}
```

| Field | Purpose |
|---|---|
| `name` | Agent name (overrides any inline `agent X runs Y`) |
| `role` | Role this agent plays |
| `module` | Path to a TypeScript or JavaScript module — its default export becomes `$agent` inside zones |
| `config` | Static config passed to the module on load |

### 4.3 Native module (`impl.ts`)

```typescript
export default {
  async decide_bid(itemName: string, reservePrice: number) {
    return reservePrice * 1.1;
  },
};
```

Functions exposed via the default export become `$agent.functionName(...)`
calls inside zone bodies.

### 4.4 `out/` artifacts

After `reagent build .`:

```
out/
├── <Proto>.<role>.ir.json   # per-role IR graph (one per role)
├── <Role>.role.json          # per-role behavioral IR
├── <Agent>.agent.json        # per-agent deployment binding
├── deployment.json           # agent → role → graph mapping
├── messages.json             # message schemas
└── source-map.json           # source map for the debugger
```

Plus `reagent.lock` (versioned fingerprints — see [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md)).

---

## 5. Authoring `.rg` Protocols

### 5.1 Core constructs

| Construct | Role |
|---|---|
| `message Name { field: T }` | Typed message schema |
| `protocol Name { participants: ..., trigger ..., body }` | Choreography |
| `role RoleName [lang] { plays Proto as part }` | Behavioral contract — `plays` bindings, optional `init`, lifecycle handlers |
| `agent Name runs RoleName` | Deployment binding |
| `RoleName { ... }` (zone) | Embedded host-language code inside the protocol body |
| `onSend { ... } / onReceive { ... }` | Message-step hooks (inline zones) |

See [`02-lang-spec.md`](02-lang-spec.md) for the full surface: triggers
(`invoke`, `cron`, `event`), participant modifiers (`static|dynamic`,
`single|many`, `initiator`), control flow (`alt`, `par`, `loop`, `scatter`,
`invoke`, `spawn`, `try/catch`, `wait`), resolve declarations, and
`role extends`.

### 5.2 Runtime bindings inside zones

Four bindings are injected into every zone:

| Binding | Scope |
|---|---|
| `$ctx` | Per-instance working memory — fresh per protocol run, isolated per role |
| `$self` | Persistent agent state across protocol runs |
| `$agent` | The agent's native module (default export of `module` field in `agent.json`) — `null` if no module |
| `reagent` | Runtime library: `reagent.emit("topic", payload)`, `reagent.log(...)`, scatter helpers |

Zones are plain TypeScript / Python / etc. — Reagent only balances braces in
the parser and forwards the body to the host language. There is no zone-level
type checking from the Reagent toolchain itself.

### 5.3 Language tags

- `[ts]` — TS zones; executed natively by the RC. **Default** today.
- `[py]` — Python zones; dispatched to the helper in `runtime/ts/zone-execs/py/`.
  Whole-agent `agent X runs Role[py]` is unsupported on the TS RC; only
  zone-level `[py]` execution is wired.
- `[js]`, `[kt]` — present in the grammar; not currently executed on the TS RC.
- `[*]` — wildcard, language-agnostic role. Such roles participate in the
  choreography (send/receive) but MUST NOT have zones. Use for adapter or
  wire-only roles whose language is decided at deployment time.

### 5.4 Zone-code tips

These apply to any host language, with the obvious Python-specific notes
called out:

- Use the host language's native syntax — Python zones use Python syntax
  (`"won" if x else "lost"`, `len(x)`, `.append()`); TypeScript zones use
  TypeScript.
- For Python dict literals use string keys: `{"key": value}`.
- `$agent.method()` calls into the agent's native module.
- `await $agent.async_fn()` is supported for asynchronous native calls.
- In Python zones, `.push()` on lists is automatically translated to
  `.append()`.

---

## 6. CLI Reference (`reagent`)

All commands are invoked via `node lang/dist/cli.js <command>` (or as
`reagent-lang <command>` if installed globally).

| Command | Syntax | Description |
|---|---|---|
| `parse` | `reagent parse <file.rg>` | Parse and print AST as JSON |
| `ir` | `reagent ir <file.rg> [role]` | Emit IR to stdout (optionally filter by role) |
| `validate` | `reagent validate <file.rg> [role]` | Emit IR + validation diagnostics |
| `compile` | `reagent compile <file.rg> <out-dir>` | Compile one `.rg` file to IR JSON files |
| `build` | `reagent build [project-dir]` | Build all protocols listed in `reagent.json` |
| `init` | `reagent init [dir]` | Scaffold a new Reagent project |
| `decompile` | `reagent decompile <dir\|file.ir.json>` | Reconstruct `.rg` from compiled IR |
| `verify` | `reagent verify <file.rg>` | Generate TLA+ spec, run TLC model checker (see §10) |
| `deploy` | `reagent deploy [project-dir] [url]` | Build and deploy to a control-plane server (default `ws://127.0.0.1:18789`) |

---

## 7. Running Projects

The TS RC is the single execution target. There are two practical ways to
drive it: the IDE Run button (for tight inner loops), and a programmatic
runner (for CI, headless setups, and multi-node deployments).

### 7.1 IDE Run button (▶)

With a `.rg` file open, click the **▶ play button** in the editor title bar
(or run `Reagent: Run Protocol` from the command palette).

The extension:

1. Finds `reagent.json` above the `.rg` file
2. Compiles the `.rg` to IR in-process via `@reagent/lang`
3. Runs the protocol in-process via `@reagent/agent-runtime`

Output goes to the **Reagent Run** output channel.

### 7.2 Programmatic runner (headless / multi-node)

For CI, daemonised nodes, or multi-node deployments, write a project-local
runner that bootstraps a `ReagentController` and wires it to the chosen
`BehaviorFactory`. A complete reference runner lives at
[`examples/projects/auction-sim/run_node.ts`](../../examples/projects/auction-sim/run_node.ts).

Minimal shape:

```typescript
import {
  ManagedBehaviorFactory,
  ReagentController,
  bootstrapRuntime,
  type RuntimeConfig,
} from "@reagent/agent-runtime";

const rc = new ReagentController({
  nodeId: runtimeConfig.nodeId,
  behaviorFactory: new ManagedBehaviorFactory(),
  stateStore: runtime.stateStore,
});

const runtime = await bootstrapRuntime(runtimeConfig, rc, { stateStore });
await rc.start();

// load compiled IR from out/, deploy agents, trigger the protocol …
```

Then run with:

```bash
node lang/dist/cli.js build .
npx tsx run_node.ts            # or: node dist/run_node.js
```

The runtime config (`node.runtime.json`) declares the state store
(`memory` vs `etcd`), message plane, telemetry, and control endpoint —
see [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md) §6.

### 7.3 Edit-run loop

| Change | Action |
|---|---|
| Agent native module (`impl.ts`) | Re-run; no rebuild needed |
| `.rg` protocol body / messages / control flow | `reagent build .` then re-run |
| `reagent.json` / `agent.json` | `reagent build .` then re-run |

Fingerprints in `reagent.lock` classify rebuild changes as MAJOR (structure),
MINOR (schema), or PATCH (impl-only); see [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md) §4.

---

## 8. Integration Modes

The RC speaks one contract to agents: `BehaviorFactory` (see [`03-runtime-core.md`](03-runtime-core.md) §3).
Four ready-made factories cover most needs, plus a Claude-specific wrapper.

### 8.1 Managed (default)

Zone code lives in `.rg`. The RC compiles and executes zones in-process via
`ManagedBehaviorFactory`. This is the path the IDE Run button uses.

```typescript
import { ManagedBehaviorFactory, ReagentController } from "@reagent/agent-runtime";

const rc = new ReagentController({
  nodeId: "node-1",
  behaviorFactory: new ManagedBehaviorFactory(),
});
```

**When**: most projects, especially tight edit-run loops; zones co-located with
the protocol and debuggable in the IDE.

### 8.2 Custom

The user supplies an `AgentBehavior` implementation directly. The `.rg` file
only defines choreography; no zones are needed.

```typescript
import { CustomBehaviorFactory } from "@reagent/agent-runtime";

const factory = new CustomBehaviorFactory({
  behaviorFactory: (agentName, roleIR) => ({
    async handle(event) {
      switch (event.type) {
        case "action":         return { type: "ctx_update", ctx: { result: "done" } };
        case "send_required":  return { type: "send_payload", payload: { result: "done" } };
        default:               return { type: "noop" };
      }
    },
  }),
});
```

**When**: agent logic is complex, needs full TypeScript control, or integrates
with existing code where zone bodies are limiting.

### 8.3 Message Gate

The agent runs as an external process (separate container, language, or
host). The RC communicates via JSON-serialised `ProtocolEvent` /
`AgentResponse` frames through a `GateTransport`.

```typescript
import { GateBehaviorFactory, WsGateTransport } from "@reagent/agent-runtime";

const factory = new GateBehaviorFactory({
  transportFactory: (agentName) =>
    new WsGateTransport(`ws://worker-host:8080/${agentName}`),
});
```

Three bundled transports:

| Transport | Mechanism |
|---|---|
| `WsGateTransport` | WebSocket frames |
| `StdioGateTransport` | Line-delimited JSON on stdin/stdout |
| `HttpGateTransport` | `POST /event`; response body = `AgentResponse` |

**When**: polyglot or microservice deployments; isolation of agent processes.
Push model — RC initiates communication.

### 8.4 MCP Gate

Agents attach as MCP clients to a `mcp-gate` subprocess; communication is
pull-style — the agent actively requests events via MCP tools.

The simplest path is launching `mcp-gate` from an MCP client (e.g. Cursor)
with a runtime config:

```json
{
  "mcpServers": {
    "reagent": {
      "command": "node",
      "args": ["mcp-gate.js", "--runtime-config", "./my-agent.runtime.json"]
    }
  }
}
```

Agents interact with the protocol via MCP tools:

| Tool | Description |
|---|---|
| `reagent/register` | Attach the agent's `AgentRuntime`; declare roles |
| `reagent/wait_for_events` | Long-poll for protocol events |
| `reagent/respond` | Submit an `AgentResponse` |
| `reagent/invoke` | Start a new protocol instance |
| `reagent/list_protocols` | List available protocols |
| `reagent/list_instances` | List active instances |
| `reagent/get_state` | Get instance state |

Implementation pieces: `McpAgentAdapter` (per-agent bridge) and
`ReagentMcpServer` (stdio MCP server). See
[`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md) §7 for
the gate lifecycle.

**When**: LLM agents (Claude Code, Cursor, any MCP client). Pull model suits
agents that reason asynchronously between protocol steps.

### 8.5 Claude live-agent wrapper

For Claude-backed live agents (`claude-node.ts`), the recommended UX is a
single config file that wraps both the RC runtime config and Claude-specific
settings. This keeps core `RuntimeConfig` free of Claude knobs.

```json
{
  "kind": "claude_live_agent_node",
  "runtime": { "...": "RuntimeConfig" },
  "agent": { "name": "WorkerAgent", "roles": ["WorkerRole"] },
  "claude": {
    "tools": [],
    "mcpServers": {},
    "maxTurns": 4,
    "permissionMode": "bypassPermissions",
    "extraInstructions": "..."
  }
}
```

`claude-node.ts` reads this wrapper, materialises the embedded runtime
config, and bootstraps an in-process RC backed by `ClaudeBehaviorFactory`.

---

## 9. Debugging

Reagent ships a protocol-level debug session driven through the control
plane, with breakpoints on `send`, `receive`, and `action` states.

1. Start the control-plane server: `Cmd+Shift+P` → **Reagent: Start Control Plane**
2. Open a `.rg` file
3. `Cmd+Shift+P` → **Reagent: Start Debug Session**

The debug panel shows:

- Trace timeline (sends / receives / actions)
- Agent state (`$self`)
- Held messages at breakpoints

The debug flow runs against the TypeScript runtime; protocol diagrams react
to debug state where supported. For administrative operations outside the
debug UI use the `reagent-rgctl` CLI or `AdminClient` directly — see §12.

---

## 10. Verification (`reagent verify`)

`verify` compiles a protocol to IR, emits a TLA+ specification, and (if
`tlc` is on PATH) runs the model checker automatically.

```bash
node lang/dist/cli.js verify protocols/my-protocol.rg
```

Checks:

- **Deadlock freedom** — every role can reach a terminal state
- **Protocol completion** — no infinite loops without progress

Output:

```
=== MyProtocol ===
  Generated: MyProtocol.tla, MyProtocol.cfg
  Roles: alice, bob
  States per role: alice=5, bob=4
  Running TLC model checker...
  ✓ MyProtocol: all properties satisfied
```

If TLC is not installed, only `.tla` and `.cfg` are written:

```
(TLC not found on PATH — run manually: tlc MyProtocol.tla -config MyProtocol.cfg)
```

Install TLC from [TLA+ tools](https://github.com/tlaplus/tlaplus/releases)
and put `tlc` on PATH.

---

## 11. Observability (OpenTelemetry)

Two hook points; both are optional and additive.

### Message-level interceptor

One root span per protocol instance plus child spans per message.

```typescript
import { createOTelInterceptor, ReagentController } from "@reagent/agent-runtime";

const rc = new ReagentController({
  nodeId: "my-node",
  behaviorFactory: new ManagedBehaviorFactory(),
  interceptors: [createOTelInterceptor()],
});
```

### Agent-level trace hook

Spans for agent-level events (state transitions, zone execution, lifecycle).

```typescript
import { createOTelTraceHook } from "@reagent/agent-runtime";

const rc = new ReagentController({
  nodeId: "my-node",
  behaviorFactory: new ManagedBehaviorFactory(),
  traceHook: createOTelTraceHook(),
});
```

### Exporters

Configure an OTLP / Jaeger / Zipkin SDK provider once at process start:

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new JaegerExporter()));
provider.register();
```

Traces show up in your collector UI once the process emits any protocol activity.

---

## 12. Cluster & Multi-Node

For multi-node deployments Reagent uses embedded etcd for node membership
and agent discovery. Each node registers itself with a lease-based key in
etcd; agent registrations include the hosting `nodeId`. Other nodes watch
these keys and auto-populate their routing tables.

```typescript
import {
  bootstrapCluster,
  ManagedBehaviorFactory,
  ReagentController,
} from "@reagent/agent-runtime";

const cluster = await bootstrapCluster({
  nodeId: "node-1",
  // For multi-node: peers: ["node-1=http://host1:2380", "node-2=http://host2:2380"],
});

const rc = new ReagentController({
  nodeId: "node-1",
  behaviorFactory: new ManagedBehaviorFactory(),
  stateStore: cluster.stateStore,
  cronLeaderElection: cluster.cronLeaderElection,
});

await rc.start();
// … deploy agents, run protocols …
await rc.stop();
await cluster.shutdown();
```

Key components:

| Component | File | Purpose |
|---|---|---|
| `EtcdManager` | `etcd-manager.ts` | Download, cache, start/stop the etcd binary |
| `EtcdStateStore` | `etcd-state-store.ts` | `StateStore` implementation via `etcd3` |
| `EtcdMembership` | `etcd-membership.ts` | Node presence + agent routing through watch |
| `LeaderElection` | `leader-election.ts` | Lease-based leader lock (used by `CronAgent`) |
| `bootstrapCluster` | `cluster-bootstrap.ts` | Ties `EtcdManager`, `EtcdStateStore`, and `LeaderElection` together |

`CronAgent` uses `LeaderElection` so only one node fires cron ticks across
the cluster. Trigger de-duplication uses `putIfAbsent` CAS locks in the
StateStore to prevent duplicate fires across nodes.

Tools and operations talk to the cluster through `AdminClient` (not a
central always-on orchestrator):

```bash
# Cluster status, node inspection, trigger, list/stop agents, list protocols
node runtime/ts/dist/rgctl.js cluster-status --etcd-hosts http://127.0.0.1:2379
node runtime/ts/dist/rgctl.js inspect-node  --node node-1 --etcd-hosts ...
node runtime/ts/dist/rgctl.js trigger       --agent Alice --protocol HelloWorld --input '{"text":"hi"}'
```

For the full control-plane model — `AdminClient`, `NodeControlEndpoint`,
`StateStoreProvider`, protocol-run records — see
[`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md).

---

## 13. Scaling: Scatter Patterns

For large scatter operations (100+ branches), Reagent ships two scaling
helpers in `@reagent/agent-runtime`.

### Streaming scatter

Results arrive incrementally as each branch completes:

```typescript
import { streamingScatter } from "@reagent/agent-runtime";

const results = await streamingScatter(
  items,
  async (branch) => processBranch(branch.item),
  (result) => console.log(`Branch ${result.index} completed`),
  { concurrencyLimit: 10 },
);
```

### Partitioned scatter

Automatically partitions when item count crosses a threshold:

```typescript
import { partitionedScatter } from "@reagent/agent-runtime";

const results = await partitionedScatter(
  items, // e.g. 500 items
  async (branch) => processBranch(branch.item),
  (result) => onBranchDone(result),
  { partitionThreshold: 50, partitionSize: 25 },
);
```

---

## 14. Examples

Worked-out, runnable projects live under `examples/projects/`:

| Project | Theme |
|---|---|
| [`auction-sim`](../../examples/projects/auction-sim/) | Single-round sealed-bid auction (1 seller, 3 buyers); reference shape for `run_node.ts` plus `node.runtime.json` |
| [`task-delegation`](../../examples/projects/task-delegation/) | Cross-host task delegation; exercises the live story lane |
| [`feature-development-reagent`](../../examples/projects/feature-development-reagent/) | Composite agents and orchestration |
| [`autoscience`](../../examples/projects/autoscience/) | Multi-agent simulation / scoring scenarios |

Run `auction-sim` headlessly:

```bash
cd examples/projects/auction-sim
node ../../../lang/dist/cli.js build .
npx tsx run_node.ts --auto-deploy
```

Protocol-only fixtures (one file per language construct, 25+ in total) live
under `examples/protocols/src/`. They are exercised by the compiler and
runtime test suites and serve as a reference catalogue for syntax features.

For canonical end-to-end use cases spanning managed / cluster / MCP /
custom / hybrid runtime shapes, see [`09-e2e-usecases.md`](09-e2e-usecases.md).

---

## Appendix A — IDE Commands Reference

| Command | Shortcut / Surface | Context | Description |
|---|---|---|---|
| Reagent: Run Protocol | ▶ button | `.rg` file open | Compile and run in-process via the TS RC |
| Reagent: Open Diagram | ⎅ button | `.rg` file open | Sequence diagram for the current protocol |
| Reagent: Open Project Overview | graph button | `.rg` file open | Agents / roles / protocols overview |
| Reagent: Start/Stop Control Plane | command palette | Any | Manage the local control-plane server |
| Reagent: Start Debug Session | command palette | `.rg` file open | Launch a debug session |
| Reagent: Inspect Agent State | command palette | Debug session active | Query agent `$self` state |
| Reagent: Show Trace Timeline | command palette | Debug session active | Focus the trace timeline panel |

LSP intelligence (symbols `Cmd+Shift+O`, hover, go-to-definition, completion)
is on by default whenever a `.rg` file is open. See [`07-lsp.md`](07-lsp.md).

---

## Appendix B — Further Reading

| Topic | Doc |
|---|---|
| Language surface and IR | [`02-lang-spec.md`](02-lang-spec.md) |
| Runtime core, RC, R1 ontology | [`03-runtime-core.md`](03-runtime-core.md) |
| Cluster, control plane, message plane | [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md) |
| Versioning, registry, reconcile | [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md) |
| Tooling, debug UX, observability | [`06-tooling-overview.md`](06-tooling-overview.md) |
| Language server | [`07-lsp.md`](07-lsp.md) |
| Test inventory and lanes | [`08-test-spec.md`](08-test-spec.md) |
| Representative end-to-end use cases | [`09-e2e-usecases.md`](09-e2e-usecases.md) |
| Python runtime retirement plan | [`../future/retire-python-runtime.md`](../future/retire-python-runtime.md) |
