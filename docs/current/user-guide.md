# Reagent User Guide

How to create, compile, run, and debug Reagent projects.

---

## 1. Prerequisites

| Tool | Purpose |
|------|---------|
| **Cursor / VSCode** | IDE with Reagent extension |
| **Node.js ≥ 18** | Reagent compiler (`@reagent/lang`) |
| **Python ≥ 3.10** | Running `[py]` agents |
| **Reagent VSIX** | Syntax highlighting, diagrams, run/debug |

Install the extension:

```bash
cd projects/reagent/tools/reagent-vscode
npm run package
cursor --install-extension reagent-vscode-0.0.9.vsix --force
```

---

## 2. Project Structure

A Reagent project is a directory with a `reagent.json` manifest:

```
my-project/
├── reagent.json          # project manifest
├── protocols/
│   └── my-protocol.rg   # protocol definitions
├── agents/
│   ├── alice/
│   │   ├── agent.json    # agent manifest
│   │   └── module.py     # $agent native module
│   └── bob/
│       ├── agent.json
│       └── module.py
├── run.py                # project runner (Python projects)
└── out/                  # compiled IR (generated)
```

### `reagent.json`

```json
{
  "name": "my-project",
  "version": "0.0.1",
  "protocols": ["protocols/**/*.rg"],
  "agents": ["agents/*/agent.json"]
}
```

### `agent.json` (per agent)

```json
{
  "name": "Alice",
  "role": "SellerRole",
  "module": "./module.py",
  "config": { "maxPrice": 500 }
}
```

The `module` field points to a Python file whose exported functions become
available inside `.rg` zones as `$agent.function_name()`.

### Writing Your First `.rg` Protocol

A minimal protocol with two participants:

```
message Greeting { text: string }
message Reply    { text: string }

protocol HelloWorld {
  participants: alice [py], bob [py]
  initiator: alice
  input: Greeting

  alice {
    $ctx.msg_text = $ctx.input.text
  }

  alice --> bob: Greeting = {
    onSend  { $ctx.msg.text = $ctx.msg_text }
    onReceive { $self.received = $ctx.msg.text }
  }

  bob --> alice: Reply = {
    onSend  { $ctx.msg.text = "Hello back!" }
    onReceive { $self.reply = $ctx.msg.text }
  }
}

role AliceRole [py] { plays HelloWorld as alice }
role BobRole   [py] { plays HelloWorld as bob }

agent Alice runs AliceRole
agent Bob   runs BobRole
```

Key elements:
- **`message`** — typed message schemas
- **`protocol`** — choreography with participants, initiator, and input type
- **`role`** — behavioral contract (`plays` bindings, optional `init`, lifecycle handlers)
- **`agent`** — deployment binding (`runs` a role)
- **Zones** (`alice { ... }`) — embedded host-language code with access to `$ctx`, `$self`, `$agent`

### Scaffold a new project

```bash
node lang/dist/cli.js init my-project
```

Creates the directory layout, `reagent.json`, and empty `protocols/` + `agents/`
folders.

---

## 3. Writing Protocols

Protocols live in `.rg` files. Open any `.rg` file in the IDE to get:

- **Syntax highlighting** — keywords, messages, zones, `$ctx`/`$self`/`$agent`
- **Protocol diagram** — click the graph icon (⎅) in the editor title bar
- **Project overview** — click the project-graph icon in the editor title bar
- **LSP intelligence** — symbols (`Cmd+Shift+O`), hover, go-to-definition, completion

### Zone code rules for `[py]` agents

Zones are embedded Python code. A few things to remember:

- Use **Python syntax** — `"won" if x else "lost"` not `x ? "won" : "lost"`
- Dict literals need **string keys** — `{"key": value}` not `{key: value}`
- Use `len(x)` not `x.length`
- `.push()` is automatically translated to `.append()`
- `$agent.method()` calls functions from the agent's `module.py`
- `await` is supported — mark async calls with `await $agent.my_async_fn()`

---

## 4. CLI Commands

All commands are invoked via `node lang/dist/cli.js <command>` (or `reagent-lang <command>` if installed globally).

| Command | Syntax | Description |
|---------|--------|-------------|
| `parse` | `reagent parse <file.rg>` | Parse and print AST as JSON |
| `ir` | `reagent ir <file.rg> [role]` | Emit IR to stdout (optionally filter by role) |
| `validate` | `reagent validate <file.rg> [role]` | Emit IR + validation diagnostics |
| `compile` | `reagent compile <file.rg> <out-dir>` | Compile one `.rg` file to IR JSON files |
| `build` | `reagent build [project-dir]` | Build all protocols from `reagent.json` |
| `init` | `reagent init [dir]` | Scaffold a new Reagent project |
| `decompile` | `reagent decompile <dir\|file.ir.json>` | Reconstruct `.rg` from compiled IR |
| `verify` | `reagent verify <file.rg>` | Generate TLA+ spec, run TLC model checker |
| `deploy` | `reagent deploy [project-dir] [ros-url]` | Build and deploy to ROS (default: `ws://127.0.0.1:18789`) |

### `build` output

The `build` command reads `reagent.json` and produces:

```
out/
├── MyProto.roleA.ir.json    # per-role IR graph
├── MyProto.roleB.ir.json
├── MyRole.role.json          # per-role behavioral IR
├── MyAgent.agent.json        # per-agent deployment binding
├── deployment.json           # agent→role→graph mappings
├── messages.json             # message schemas
└── source-map.json           # source mapping for debugger
```

Plus updates `reagent.lock` (versioned fingerprints for change detection).

---

## 5. Running

### Option A: `run.py` (recommended for Python projects)

Create a `run.py` at the project root. This is the canonical entry point.

Minimal `run.py`:

```python
import asyncio, os, sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Adjust the path to point to reagent_runtime
sys.path.insert(0, os.path.normpath(os.path.join(SCRIPT_DIR, "path/to/runtime/py")))

from reagent_runtime import ReagentController, InprocAgentNode

async def main():
    node = InprocAgentNode(role_to_agent={})
    rc = ReagentController(node_id="my-project", agent_node=node)

    # Loads deployment.json, role IRs, protocol graphs, agent.json manifests
    role_to_agent = rc.load(os.path.join(SCRIPT_DIR, "out"))

    await rc.start()

    rc.trigger_protocol("Alice", {
        "instanceId": "run-001",
        "protocolName": "MyProtocol",
        "input": {"key": "value"},
        "roleToAgent": role_to_agent,
    })

    # Wait for the initiator to finish
    await rc.get_agent("Alice").wait_for_completion(expected_count=1, timeout_s=10)
    await rc.stop()

    # Print results
    print(rc.get_agent("Alice").get_self())

asyncio.run(main())
```

Run from the terminal:

```bash
# Compile first
node lang/dist/cli.js build .

# Run
python run.py
python run.py --item "Gold Watch" --reserve 200   # with custom args
python run.py -v                                    # verbose / debug logging
```

### Option B: IDE Run button (▶)

When you have a `.rg` file open, click the **▶ play button** in the editor
title bar (or run `Reagent: Run Protocol` from the command palette).

The extension:
1. Looks for `reagent.json` above the `.rg` file
2. If it finds `run.py` in the project root → executes `python3 run.py`
3. Otherwise → runs the protocol in-process using the TypeScript runtime

Output appears in the **Reagent Run** output channel.

### Option C: CLI-only (no IDE)

For CI or headless execution:

```bash
node lang/dist/cli.js build .
python run.py
```

---

## 6. Three Integration Modes

Reagent supports three ways to connect agent logic to a protocol.
All three produce `AgentHandle` objects that the RC manages uniformly.

### 6.1 Managed Mode (default)

Agents have zone code embedded in `.rg` files. The RC compiles and executes zones in-process.

```
protocol MyProto {
  participants: worker [py], manager [py]
  initiator: manager
  input: TaskRequest

  manager --> worker: TaskRequest = {
    onSend    { $ctx.msg.task = $ctx.input.task }
    onReceive { $self.currentTask = $ctx.msg.task }
  }

  worker {
    $ctx.result = await $agent.do_work($self.currentTask)
  }

  worker --> manager: TaskResult = {
    onSend    { $ctx.msg.result = $ctx.result }
    onReceive { $self.lastResult = $ctx.msg.result }
  }
}
```

**Components**: `NativeAgentNode` → `AgentRunner` → `ProtocolInstance`

**When to use**: Most projects. Zone code is co-located with the protocol, debuggable in the IDE, and `$agent` provides native module I/O.

### 6.2 Custom Agent Mode

The user provides a class implementing `AgentInterface.handle()`. No zones are needed in the `.rg` file — the protocol only defines the choreography.

```typescript
import { CustomAgentNode } from "@reagent/runtime";

const node = new CustomAgentNode({
  roleToAgent: { "MyProto.worker": "WorkerAgent" },
  agentFactory: (agentName, roleIR) => ({
    async handle(event) {
      switch (event.type) {
        case "action":
          return { type: "ctx_update", ctx: { result: "done" } };
        case "send_required":
          return { type: "send_payload", payload: { result: "done" } };
        default:
          return { type: "noop" };
      }
    },
  }),
});
```

**Components**: `CustomAgentNode` → `CustomAgentHandle` → user's `AgentInterface`

**When to use**: When agent logic is complex, needs full TypeScript/Python control, or integrates with existing codebases where zone code is limiting.

### 6.3 Message Gate Mode

The agent runs as an external process (separate container, different language, or remote machine). The RC communicates via JSON-serialized `ProtocolEvent` / `AgentResponse` frames.

```typescript
import { MessageGateNode, WsGateTransport } from "@reagent/runtime";

const gateNode = new MessageGateNode({
  roleToAgent: { "MyProto.worker": "ExternalWorker" },
  transportFactory: (agentName) =>
    new WsGateTransport(`ws://worker-host:8080/${agentName}`),
});
```

Three transport implementations:

| Transport | Mechanism |
|-----------|-----------|
| `WsGateTransport` | WebSocket frames |
| `StdioGateTransport` | Line-delimited JSON on stdin/stdout |
| `HttpGateTransport` | `POST /event` per event, response body = `AgentResponse` |

**Components**: `MessageGateNode` → `MessageGateHandle` → `GateSession` → `GateTransport`

**When to use**: Polyglot environments, microservice architectures, or when agents must run in isolated processes/containers.

---

## 7. `reagent verify` — TLA+ Model Checking

The `verify` command compiles a protocol to IR, generates a TLA+ specification, and (if TLC is on PATH) checks safety properties automatically.

```bash
node lang/dist/cli.js verify protocols/my-protocol.rg
```

What it checks:
- **Deadlock freedom** — all roles can reach a terminal state
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

If TLC is not installed, the command generates `.tla` and `.cfg` files for manual verification:

```
  (TLC not found on PATH — run manually: tlc MyProtocol.tla -config MyProtocol.cfg)
```

Install TLC: download from [TLA+ tools](https://github.com/tlaplus/tlaplus/releases) and add `tlc` to your PATH.

---

## 8. OTel Integration

Reagent provides OpenTelemetry instrumentation for production observability.

### Message-level interceptor

`createOTelInterceptor()` creates spans for every message flowing through the RC — one root span per protocol instance, child spans per message.

```typescript
import { createOTelInterceptor } from "@reagent/runtime";

const rc = new ReagentController({
  nodeId: "my-node",
  interceptors: [createOTelInterceptor()],
});
```

### Agent-level trace hook

`createOTelTraceHook()` creates spans for agent-level events (state transitions, zone execution, protocol lifecycle).

```typescript
import { createOTelTraceHook } from "@reagent/runtime";

const node = new NativeAgentNode({
  roleToAgent: { ... },
  traceHook: createOTelTraceHook(),
});
```

### Viewing traces

Configure an OTel exporter (e.g., Jaeger, Zipkin, OTLP) in your application:

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new JaegerExporter()));
provider.register();
```

Then run your Reagent project — traces appear in your collector UI.

---

## 9. Debugging

### Python agent debugging

Add a standard Python debug configuration to your project's `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Auction",
      "type": "debugpy",
      "request": "launch",
      "program": "${workspaceFolder}/run.py",
      "args": ["--item", "Rare Painting", "--reserve", "100"],
      "console": "integratedTerminal",
      "justMyCode": false
    }
  ]
}
```

This lets you:
- Set breakpoints in `module.py` files (agent logic)
- Set breakpoints in `run.py` (orchestration)
- Inspect `$self`, `$ctx` state in the debugger's variables panel
- Step through agent decision functions

### ROS debug session (advanced)

For protocol-level debugging with breakpoints on send/receive/action states:

1. Start ROS: `Cmd+Shift+P` → `Reagent: Start ROS`
2. Open a `.rg` file
3. `Cmd+Shift+P` → `Reagent: Start Debug Session`

The debug panel shows:
- Trace timeline (message sends/receives)
- Agent state (`$self`)
- Held messages

> **Note**: ROS debugging currently supports the TypeScript runtime. For Python
> projects, use the Python debugger approach above.

---

## 10. Modifying Agent Code

The typical edit-run cycle:

1. **Edit** `agents/<name>/module.py` — change the agent's decision logic
2. **Run** `python run.py` — no recompile needed (Python modules are loaded fresh)
3. **Iterate** — change logic, run again

You only need to **recompile** (`node lang/dist/cli.js build .`) when you change
the `.rg` protocol file — message structure, control flow, zones.

---

## 11. IDE Commands Reference

| Command | Shortcut | Context | Description |
|---------|----------|---------|-------------|
| Reagent: Run Protocol | ▶ button | `.rg` file open | Run via `run.py` or in-process TS |
| Reagent: Open Diagram | ⎅ button | `.rg` file open | Sequence diagram for current protocol |
| Reagent: Open Project Overview | graph button | `.rg` file open | Agents/roles/protocols overview |
| Reagent: Start Debug Session | — | `.rg` file open | Launch ROS debug session |
| Reagent: Inspect Agent State | — | Debug session active | Query agent `$self` state |
| Reagent: Show Trace Timeline | — | Debug session active | Focus the trace timeline panel |
| Reagent: Start/Stop/Toggle ROS | — | Any | Manage the Reagent Orchestration Server |

---

## 12. Example: `auction-sim`

Located at `examples/projects/auction-sim/`. A single-round sealed-bid auction with 1 seller + 3 buyers (all Python).

```bash
cd examples/projects/auction-sim

# Compile
node ../../../lang/dist/cli.js build .

# Run
python run.py
python run.py --item "Gold Watch" --reserve 200
python run.py -v   # debug output

# Debug (in IDE)
# Open auction.rg, set breakpoints in agents/buyer/module.py, press F5
```

The protocol uses `scatter` for bid collection, `$agent` for native module integration, and per-agent folder structure with `agent.json` manifests.

Modify `agents/buyer/module.py` → `decide_bid()` to change bidding strategy.
No recompile needed — just run again.

### More examples

- **Protocol-only examples**: `examples/protocols/src/` — 25+ examples covering all language constructs (00-24)
- **RAP sub-protocols**: now part of `@reagent/system` package at `packages/reagent-system/protocols/rap/`

---

## 13. Gossip Discovery

For multi-node deployments, Reagent supports SWIM-like gossip discovery instead of static routing:

```typescript
import { DiscoveryAgent } from "@reagent/runtime";

const discovery = new DiscoveryAgent({
  nodeId: "my-node",
  seeds: ["node-1", "node-2"],
  probeIntervalMs: 1000,
  probeTimeoutMs: 500,
  send: (targetNodeId, message) => {
    // Route via your transport layer
  },
});

discovery.setLocalAgents(["BuyerAgent", "SellerAgent"]);
discovery.start();

// Query routing table
const routes = discovery.getRoutingTable();
// Map<string, string>: agentName → nodeId
```

The gossip protocols (`Ping`, `IndirectPing`, `MembershipUpdate`) are defined in `packages/reagent-system/protocols/discovery/gossip.rg`. Membership changes are piggybacked on all gossip messages for protocol-free dissemination.

## 14. Scatter Scaling

For large-scale scatter operations (100+ branches), use the streaming and partitioned scatter APIs:

### Streaming scatter

Results arrive incrementally as each branch completes:

```typescript
import { streamingScatter } from "@reagent/runtime";

const results = await streamingScatter(
  items,
  async (branch) => processBranch(branch.item),
  (result) => console.log(`Branch ${result.index} completed`),
  { concurrencyLimit: 10 },
);
```

### Partitioned scatter

Automatically partitions when item count exceeds a threshold:

```typescript
import { partitionedScatter } from "@reagent/runtime";

const results = await partitionedScatter(
  items, // e.g., 500 items
  async (branch) => processBranch(branch.item),
  (result) => onBranchDone(result),
  { partitionThreshold: 50, partitionSize: 25 },
);
```

## 15. Self-Hosting

The ROS (Reagent Orchestrator Service) uses its own internal `ReagentController` for managing system protocols and agents. On startup, the ROS creates a system RC (`nodeId: "ros-system"`) that can host system agents (Orchestrator, Debugger, Reconciler, Discovery). This makes infrastructure operations observable and debuggable via the same tools used for user protocols. See `docs/orchestrator.md` §8 for details.
