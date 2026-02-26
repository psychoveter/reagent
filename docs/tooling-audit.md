# Reagent Tooling Audit

Date: 2026-02-25
Scope: VSCode extension, ROS, cluster instruments, Python runtime, documentation

---

## 1. VSCode extension file inventory (5213 LOC)

| File | LOC | Purpose | Status |
|---|---|---|---|
| `reagentDebugAdapter.ts` | 618 | DAP adapter: breakpoints, step, variables, RAP ↔ DAP bridge | Working — tested with ROS |
| `diagramPanel.ts` | 536 | Protocol View webview: sequence/SM tabs, trigger bar, source click | Working — trigger bar broken (see §3) |
| `clusterPanel.ts` | 420 | Tree view: nodes/protocols/agents, RAP polling, NodeInspect cache | Working |
| `extension.ts` | 416 | Activation: 16 commands, providers, wiring | Working — was broken by missing node_modules in VSIX (fixed) |
| `projectDiagram.ts` | 353 | Regex scanner for reagent.json → agent/role/protocol SVG | Working |
| `sequenceDiagram.ts` | 336 | IR → sequence SVG: participants, arrows, control boxes, pills | Working — spacing tuned |
| `stateMachineDiagram.ts` | 335 | IR → state machine SVG (no ELK, linear layout) | Working — basic |
| `runController.ts` | 307 | `reagent.run`: in-process compile+execute, PythonAgentNode IPC | Working |
| `projectDiagramPanel.ts` | 293 | Project Overview webview panel | Working |
| `rosManager.ts` | 210 | Start/stop ROS subprocess, probe, adopt, freePort, status bar | Working |
| `embeddedLanguageMiddleware.ts` | 196 | Completion/hover/definition delegation to host language LSPs | Working |
| `reagentParser.ts` | 192 | Parse `.rg` for zone extraction (embedded lang support) | Working |
| `tracePanel.ts` | 178 | Sidebar trace table: icons, kind, agent, detail | Working |
| `deployController.ts` | 146 | Read `out/` → DeployProject RAP → distribute to nodes | Working |
| `virtualDocumentProvider.ts` | 132 | Virtual doc scheme for embedded languages | Working |
| `rapClient.ts` | 128 | WebSocket client for RAP protocol | Working |
| `debugPanelProvider.ts` | 121 | Debug sidebar webview (trace timeline) | Working — wired via pushStateToSinks() |
| `inlineValues.ts` | 109 | Gutter decorations for $ctx/$self | Working — wired via pushStateToSinks() |
| `diagramController.ts` | 100 | DAP Stopped → diagram highlight bridge | Working |
| `projectCodeLens.ts` | 55 | Compile/Deploy/Trigger CodeLens on reagent.json | Working |
| `codeLensProvider.ts` | 32 | "View" CodeLens on `protocol` lines | Working (just changed) |

## 2. ROS (orchestrator) — 1195 LOC

### RAP message catalog

| RAP message | Handler | Response | Updates cluster state? |
|---|---|---|---|
| `Register` | `handleAdapterRegister` | `Accepted`/`Rejected` | Yes — adds node |
| `Deployed` | `handleAdapterDeployed` | — | Yes — adds/updates agent |
| `TraceEvent` | `handleAdapterTrace` | — (broadcasts to clients) | No |
| `Compile` | `handleCompile` | `CompileSuccess`/`CompileFailed` | No |
| `RunStart` | `handleRunStart` | `RunStarted`/`RunFailed` | No |
| `SetBreakpoints` | `handleSetBreakpoints` | `BreakpointsSet` | No |
| `DebugCommand` | `handleDebugCommand` | `Stopped`/`Continued` etc. | No |
| `GetState` | `handleGetState` | `StateSnapshot`/`InspectError` | No |
| `ListProtocols` | `handleListProtocols` | `ProtocolsList` | No |
| `DeployProtocol` | `handleDeployProtocol` | `DeployProtocolSuccess`/`Failed` | Yes — adds protocol |
| `ClusterStatus` | `handleClusterStatus` | `ClusterStatusResponse` | No (reads state) |
| `SubmitDeploySpec` | `handleSubmitDeploySpec` | `ReconciliationResult` | Maybe |
| `StopAgent` | `handleStopAgent` | `AgentStopped` | Yes |
| `DeployProject` | `handleDeployProject` | `DeployProjectSuccess`/`Failed` | Yes — adds agents+protocols |
| `TriggerOnCluster` | `handleTriggerOnCluster` | — (sends TriggerProtocol to nodes) | No |
| `NodeInspect` | forwarded to adapter node | `NodeInspectResult` | No |

### Agent registration flow (DeployProject)

1. VSCode sends `DeployProject` with `deployment.json` + IR graphs + role IRs
2. ROS iterates `deployment.agents`, round-robin across connected adapter nodes
3. For each agent: sends `Deploy` to the adapter node with `{agentName, roleIR, graphs, roleToAgent, roleName, protocolName}`
4. Pre-populates `currentView.agents` with `{agentName, roleName: binding.roleName, protocolName: binding.protocolName, nodeId, status: "deploying"}`
5. Python node receives `Deploy`, registers agent, sends back `Deployed` with `{agentName, nodeId, roleName, protocolName}`
6. ROS `handleAdapterDeployed` finds existing entry, sets `status: "running"`
7. `broadcastClusterUpdate()` sends full `{nodes, agents, protocols}` to all connected clients

**Key finding**: `roleName` in `currentView.agents` is `binding.roleName` (= `"seller"`, `"buyer"` — the protocol-level role name). The `protocolName` is `"Auction"`. Both are correct on the ROS side.

## 3. Identified bugs (critical)

### BUG-1: Trigger bar shows "no agents" despite agents being deployed

**Root cause**: The diagram panel's `clusterPanel` is a **separate** `RapClient` connection from the cluster tree view's connection. The `clusterPanel.getState()` returns the live state of the tree view's client, which polls every 3 seconds. However, the diagram panel subscribes to `onDidChangeTreeData` to re-render, but:

1. The diagram panel is created by `reagent.openDiagram` command with `clusterPanel` passed from `extension.ts`
2. The `onDidChangeTreeData` listener was added in the constructor, but only fires if `this.clusterPanel` is set at construction time
3. If the panel is opened **before** connecting to the cluster, `clusterPanel` is set but has no RAP connection → `getState()` returns empty
4. After connecting and deploying, `clusterPanel` gets a RAP connection and starts receiving `ClusterUpdate` events, `_onDidChangeTreeData` fires, diagram re-renders
5. **But**: the `clusterPanel.getState().agents` filtering uses `a.protocolName === protoName`. This should match since the ROS sends `protocolName: "Auction"` correctly

**Likely actual cause**: The ClusterUpdate/ClusterStatusResponse from ROS arrives, but `agents` in the payload might not have `protocolName` set correctly. The pre-populated entries at deploy time have it, but the `Deployed` ack handler (line 654-667) looks up by `agentName + nodeId`. If the Python node's `Deployed` ack somehow creates a **new** entry (instead of finding the pre-populated one), the new entry gets `protocolName` from the ack payload which could be different.

**Reproducer needed**: Add console.log in `getClusterAgentsForProtocol` to show `state.agents` and `protoName`.

### BUG-2: VSIX packaged without node_modules (FIXED)

`vsce package --no-dependencies` skipped bundling node_modules. Extension crashed at activation with `Cannot find module 'vscode-languageclient/node'`. Fixed — now using `vsce package` without `--no-dependencies`.

### ~~BUG-3: Inline values never fire during debug~~ FALSE POSITIVE

`inlineValues.showValues()` IS called from `reagentDebugAdapter.ts` line 558 via `pushStateToSinks()` on every Stopped event. The audit was incorrect.

### ~~BUG-4: Debug panel not receiving traces~~ FALSE POSITIVE

`debugPanelProvider.addTrace()` IS called from `reagentDebugAdapter.ts` line 222 on TraceEvent, and `updateAgentState()` / `updateHeldMessages()` are called at lines 554-555 via `pushStateToSinks()`. The audit was incorrect.

## 4. dx-tooling.md freshness assessment

### Phase checklist vs reality

| Phase | Doc status | Actual status | Gap |
|---|---|---|---|
| **Phase 0: Wire + Quick Wins** | All items `[ ]` (unchecked) | inspectAgent done, RAP alignment done, language-configuration done | Doc not updated — 3+ items are actually complete |
| **Phase 1: Run + IR Diagrams** | All items `[ ]` | reagent.run (RunController) done, CodeLens done (changed to View), IR→diagram done (sequenceDiagram.ts, stateMachineDiagram.ts), live reload done, click-to-source done | Doc not updated — Phase 1 is ~80% complete |
| **Phase 2: LSP Core** | All items `[ ]` | LSP server exists (`server/src/server.ts`), symbols/diagnostics/go-to-def/completion/hover all implemented | Doc not updated — Phase 2 is ~90% complete |
| **Phase 3: Visual Debugger** | All items `[ ]` | DiagramController exists and works (DAP→diagram highlight), debug mode CSS done, active/visited/future states work | Doc not updated — Phase 3 is ~60% complete |
| **Phase 4: Deploy + Topology** | All items `[ ]` | ClusterPanel, DeployController, ROS DeployProject, TriggerOnCluster all working. Topology view: mockup only, no live data-driven renderer | Partially done — cluster instruments work, topology renderer not started |
| **Phase 5: Python Simulation** | All items `[ ]` | Python RC exists (controller.py, 376 LOC), InprocAgentNode works, RemoteNode connects to ROS | Partially done — core works, Jupyter integration not started |
| **Phase 6: Multi-Node Deployment** | All items `[ ]` | RemoteNode (Python) connects to ROS, Deploy+Trigger work cross-node | Basic flow works, no SSH provisioning, no browser bundle, no docker |
| **Phase 7: Polish + Export** | All items `[ ]` | Nothing started | Correct |

### File inventory in doc vs reality

The doc's "Appendix: File inventory" lists `renderers/mermaidExport.ts` — **doesn't exist**.
The doc lists `lang/src/mermaid.ts` — **doesn't exist**.
The doc doesn't list: `tracePanel.ts`, `clusterPanel.ts`, `deployController.ts`, `projectCodeLens.ts`, `projectDiagram.ts`, `projectDiagramPanel.ts`.

### Other outdated sections

- §1 overview table says "Inline value decorations — Done — wired via pushStateToSinks()" → **correct** (BUG-3 was a false positive)
- §1 says "One-click run — Done" and "CodeLens ▶ Run on protocol lines" → CodeLens was changed to "View" (opens diagram), Run still works via command palette
- §1 doesn't mention: cluster panel, deploy controller, trace panel, project diagram, project CodeLens
- Phase 1 says "State machine diagram renderer — ELK.js layout" → **ELK is not used**, it's a simple linear layout

## 5. Other documentation gaps

| Document | LOC | Freshness | Issues |
|---|---|---|---|
| `lang-spec.md` | 964 | Updated to v0.0.11 | $flow removed; scatter/invoke/spawn use $ctx |
| `connectivity.md` | 1111 | Current for TS runtime | Doesn't cover Python RemoteNode |
| `orchestrator.md` | 595 | Partially current | Missing DeployProject, TriggerOnCluster, NodeInspect RAP messages |
| `dx-tooling.md` | 1241 | **Significantly outdated** | See §4 above — most phases partially complete but all checklist items unchecked |
| `backlog.md` | 1150 | Unknown | Needs review against current state |
| `protocol-versioning.md` | 1029 | Design doc | Seems current |
| `lsp.md` | 227 | Current | Describes implemented LSP |
| `user-guide.md` | 316 | Current | Basic usage guide |
| `nmmo-reagent-support.md` | 123 | Design doc | Future plan for NMMO integration |

**Missing documents**:
- No RAP protocol reference (message types, payloads, flows)
- No Python runtime documentation
- No deployment/cluster operations guide
- No "getting started with cluster" tutorial

## 6. Python runtime (3374 LOC)

| File | LOC | Purpose | Status |
|---|---|---|---|
| `protocol_instance.py` | 929 | Protocol state machine execution | Working |
| `controller.py` | 376 | ReagentController: agent registry, trigger, routing | Working |
| `agent_runner.py` | 330 | Agent lifecycle: zone execution, message dispatch | Working |
| `remote_node.py` | 275 | WebSocket connection to ROS, Deploy/Trigger handling | Working |
| `zone_executor.py` | 215 | Execute agent zone code (Python eval) | Working |
| `ipc_agent_node.py` | 194 | JSON-line IPC for TS parent process | Working |
| `ipc_agent.py` | 157 | Agent running via IPC subprocess | Working |
| `protocol_registry.py` | 117 | Protocol/version registry | Working |
| `inproc_agent_node.py` | 112 | In-process agent dispatch | Working |
| `remote_node_cli.py` | 93 | CLI entry point for RemoteNode | Working |
| `__main__.py` | 99 | Package main | Working |
| `types.py` | 88 | Type definitions | Working |
| `ir_fingerprint.py` | 75 | IR hashing for version compat | Working |
| `agent_manifest.py` | 72 | Load agent.json + native module | Working |
| `nats_transport.py` | 62 | NATS transport (standalone mode) | Working |
| `local_transport.py` | 54 | LocalTransport for TS-parent IPC | Working |
| `inproc_transport.py` | 47 | InprocTransport (zero-copy) | Working |
| `agent_node.py` | 45 | Abstract AgentNode interface | Working |
| `__init__.py` | 34 | Package exports | Working |

---

## 7. Refactoring plan

### Priority 1: Fix BUG-1 (trigger bar agents) — FIXED

**Root cause**: `onDidChangeTreeData` listener called `render()` which rebuilt the entire webview HTML every 3 seconds (cluster poll interval). This caused flickering, reset scroll position, and lost trigger bar expanded/input state.

**Fix applied**: Replaced full `render()` with lightweight `updateTriggerBar()` that sends a `postMessage` to the webview. The webview JS handler (`updateTriggerBarDom`) updates only the trigger bar status text and agent dropdown DOM without replacing the page. Also unified `getTriggerBarHtml` to always render the full trigger body structure (hidden by default) so the dropdown exists for dynamic population.

### Priority 2: Update dx-tooling.md — 2h

- Check all Phase 0-3 items that are complete → mark `[x]`
- Add missing files to the file inventory
- Remove phantom files (mermaidExport.ts, mermaid.ts)
- Update §1 overview table with actual status
- Fix incorrect claims (ELK.js)
- Add new sections for: cluster panel, deploy flow, trace panel, project diagram

### ~~Priority 3: Wire remaining Phase 0 items~~ NOT NEEDED

BUG-3 and BUG-4 were false positives — wiring already exists in `pushStateToSinks()` (reagentDebugAdapter.ts lines 533-563).

### Priority 4: Add RAP protocol reference — 2h

Create `docs/rap-protocol.md` documenting all 16+ RAP message types, payloads, and flows. This is the most critical missing doc — the RAP protocol is the backbone of cluster operations.

### Priority 5: Update orchestrator.md — 1h

Add DeployProject, TriggerOnCluster, NodeInspect to the documented RAP messages. Document the Python RemoteNode connection flow.

### Priority 6: VSIX build hygiene — 30min

- Remove `--no-dependencies` from any build scripts/docs
- Add a `scripts.package` entry to package.json that includes compile+package
- Consider webpack/esbuild bundling to reduce VSIX size (currently 720KB with full node_modules)
