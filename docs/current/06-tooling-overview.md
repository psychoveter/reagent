# Tooling Overview

This document is the current overview of Reagent tooling and developer workflow support.

It replaces `dx-tooling.md` as the canonical current document.

## 1. Tooling Surface

The main tooling areas are:

- Reagent VSCode/Cursor extension
- cluster and deploy controls
- protocol and project diagrams
- debug integration
- trace and observability surfaces
- the Reagent LSP
- CLI/admin tooling through `rgctl` and `AdminClient`

For language-server specifics, see [`07-lsp.md`](07-lsp.md).

## 2. Current VSCode Extension Capabilities

### Editing and navigation

- syntax highlighting for `.rg`
- project and protocol views
- document symbols, hover, go-to-definition, completion through the LSP
- code lenses for supported workflows

### Deploy and cluster interaction

- local run flows through the extension's run controller
- cluster-facing interaction is surfaced in panels and commands
- deploy flows are driven through admin/control-plane APIs
- node inspection and cluster status are presented in the cluster panel

### Debug

- DAP adapter integrates with the current control-plane debug path
- protocol diagrams can react to debug state
- trace and state inspection surfaces exist, though richer UX remains partial

## 3. Extension Control-Plane Layer

The extension's control-plane layer is built around:

- `RapClient` — the main client class used by the extension
- `rosManager.ts` — lifecycle helper for the local control-plane server

The architecturally canonical components are:

- `AdminClient` for tool-facing cluster operations
- `StateStore` for shared cluster truth
- `NodeControlClient` / `NodeControlEndpoint` for imperative per-node operations

### `RapClient`

`tools/reagent-vscode/src/rapClient.ts` has two modes:

- WebSocket mode
- cluster mode backed by `AdminClient`, `DirectStateStoreProvider`, and `StoreBackedNodeEndpointResolver`

In cluster mode it routes key operations through `AdminClient`, including:

- cluster status
- node inspect
- deploy project
- trigger on cluster
- deployed IR lookup

In cluster mode the architecture routes through `AdminClient` rather than an always-central admin WebSocket.

### Lifecycle helper

The extension ships a lifecycle helper `rosManager.ts` that manages the control-plane server lifecycle.

It is a pragmatic local process manager for developer workflows. The architecture is `AdminClient`-first.

## 4. Deploy UX

The extension supports deploy workflows through:

- `deployController.ts`
- cluster panel
- trigger controls
- cluster-backed `RapClient` behavior

`deployController.ts` reads compiled project artifacts from `out/` and sends `DeployProject`.

In cluster mode, that request is handled through `AdminClient.deployProject(...)`, which in turn talks to node endpoints discovered from shared state.

The current mental model is that the extension deploys through the control-plane client abstraction.

## 5. Diagram Surface

Current diagram-related tooling includes:

- protocol view
- project overview view
- diagram-controller integration for debug highlighting

These tools consume compiled or runtime-derived information but should not be treated as the source of truth for runtime architecture.

The source of truth remains:

- runtime code
- numbered docs in `docs/current/`

## 6. MCP-Based Agent Tooling

For MCP-based agent participation, the current practical split is:

- Cursor usually launches `mcp-gate` directly as an MCP server subprocess
- Claude-backed live agents launch through `runtime/ts/src/nodes/claude/claude-node.ts`
- wrapper node configs embed `RuntimeConfig` plus agent/provider-specific settings

Tooling should preserve that distinction rather than pushing Claude-specific settings into the core RC runtime config schema.

This is also why wrapper configs such as Claude live-agent node configs exist:

- `RuntimeConfig` stays runtime-focused
- launch ergonomics live in host-specific wrapper config

## 7. CLI And Admin Tooling

The non-extension tooling surface now matters more than older docs implied.

Current important tool-facing entrypoints include:

- `runtime/ts/src/admin/client.ts`
- `runtime/ts/src/rgctl.ts`

`rgctl` can construct `AdminClient` either from:

- a legacy admin URL
- a state-store-backed config

This mirrors the broader transitional state of the codebase:

- canonical architecture is state-store-backed control
- some compatibility paths still accept legacy transport inputs

## 8. Observability

Current observability hooks in the runtime include:

- message-level OTel interceptor
- trace-event OTel hook

TypeScript implementation paths:

- `runtime/ts/src/observability/otel-interceptor.ts`
- `runtime/ts/src/observability/otel-trace-hook.ts`

These are runtime hooks, but they matter to tooling because they feed dashboards, traces, and cluster-debug workflows.

## 9. Current Gaps And Caveats

- Some debug flows are still partially coupled to legacy control transport patterns.
- Some source comments still mention older collection paths or central orchestration assumptions.
- The runtime tree reorganization changed many source paths; current docs should reference the layered tree rather than the old flat layout.
- Python runtime support exists, but the Python runtime was not structurally reorganized alongside the TS runtime.

## 10. Primary Files

For the current tooling surface, start with:

- `tools/reagent-vscode/src/rapClient.ts`
- `tools/reagent-vscode/src/deployController.ts`
- `tools/reagent-vscode/src/clusterPanel.ts`
- `tools/reagent-vscode/src/extension.ts`
- `tools/reagent-vscode/src/rosManager.ts`
- `runtime/ts/src/admin/client.ts`
- `runtime/ts/src/admin/node-control-client.ts`
- `runtime/ts/src/admin/node-control-endpoint.ts`
- `runtime/ts/src/rgctl.ts`
- `runtime/ts/src/nodes/claude/claude-node.ts`
- `runtime/ts/src/nodes/mcp/mcp-server.ts`
- `runtime/ts/src/nodes/mcp/mcp-agent-adapter.ts`

## 11. Where To Read Next

- For runtime architecture: [`03-runtime-core.md`](03-runtime-core.md)
- For cluster/control-plane behavior: [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md)
- For versioning/reconcile: [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md)
- For language-server details: [`07-lsp.md`](07-lsp.md)
- For test inventory: [`08-test-spec.md`](08-test-spec.md)

## 12. Short Version

If you remember only one thing from this file, remember this:

**The current tooling model is `AdminClient`-first.**
