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

## 4. Compiling

### CLI

```bash
# Single file
node lang/dist/cli.js compile protocols/my-protocol.rg out/

# Full project (reads reagent.json)
node lang/dist/cli.js build .
```

The `build` command:
1. Reads `reagent.json` to find protocol files
2. Compiles each `.rg` file to IR JSON
3. Writes `out/deployment.json` (agent→role→graph mappings)
4. Updates `reagent.lock` (versioned fingerprints)

### From the IDE

The extension auto-compiles when rendering diagrams. No manual step needed
for visualization.

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

## 6. Debugging

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

## 7. Modifying Agent Code

The typical edit-run cycle:

1. **Edit** `agents/<name>/module.py` — change the agent's decision logic
2. **Run** `python run.py` — no recompile needed (Python modules are loaded fresh)
3. **Iterate** — change logic, run again

You only need to **recompile** (`node lang/dist/cli.js build .`) when you change
the `.rg` protocol file — message structure, control flow, zones.

---

## 8. IDE Commands Reference

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

## 9. CLI Reference

```
reagent-lang compile  <file.rg> <out-dir>    Compile one .rg file to IR
reagent-lang build    [project-dir]           Build all protocols from reagent.json
reagent-lang init     [dir]                   Scaffold a new project
reagent-lang decompile <dir|file.ir.json>     Reconstruct .rg from compiled IR
```

---

## 10. Example: `auction-sim`

Located at `examples/projects/auction-sim/`.

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

The auction creates 1 seller + 3 buyers. The seller announces an item,
buyers submit random bids, the seller picks the winner, and all buyers
are notified of the result.

Modify `agents/buyer/module.py` → `decide_bid()` to change bidding strategy.
No recompile needed — just run again.
