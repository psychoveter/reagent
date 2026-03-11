# Tooling Overview

This document is the current overview of Reagent tooling and developer workflow support.
It replaces `dx-tooling.md` as the canonical current document.

## 1. Tooling Surface

The main tooling areas are:

- Reagent VSCode/Cursor extension
- ROS lifecycle and cluster controls
- protocol and project diagrams
- debug integration
- deploy controls
- trace and observability surfaces
- the Reagent LSP

For language-server specifics, see [`07-lsp.md`](07-lsp.md).

## 2. Current VSCode Extension Capabilities

### Editing and navigation

- syntax highlighting for `.rg`
- project and protocol views
- document symbols, hover, go-to-definition, completion through the LSP
- code lenses for supported workflows

### Run and deploy

- local run flows through the extension's run controller
- deploy flows use ROS
- cluster-facing interaction is surfaced in extension panels and commands

### Debug

- DAP adapter integrates with ROS debug workflows
- protocol diagrams can react to debug state
- trace and state inspection surfaces exist, though some richer UX remains partial

## 3. ROS Manager

The extension includes a ROS lifecycle helper in `tools/reagent-vscode/src/rosManager.ts`.

Its role is pragmatic:

- detect an already running ROS
- avoid duplicate spawns
- start the ROS CLI from the workspace
- manage status-bar state

This code is path-sensitive, which is why runtime entrypoints remain at the root of `runtime/ts/src`.

## 4. Diagram Surface

Current diagram-related tooling includes:

- protocol view
- project overview view
- diagram-controller integration for debug highlighting

These tools consume compiled or runtime-derived information but should not be treated as the source of truth for runtime architecture.
The source of truth remains the runtime code plus the numbered docs in this directory.

## 5. Deploy And Cluster UX

The extension supports cluster-oriented workflows through:

- deploy controller
- cluster panel
- trigger controls
- RAP client integration

These are control-plane tools layered over ROS and node-local RC hosts.

## 6. Observability

Current observability hooks in the runtime include:

- message-level OTel interceptor
- trace-event OTel hook

TS implementation paths:

- `runtime/ts/src/observability/otel-interceptor.ts`
- `runtime/ts/src/observability/otel-trace-hook.ts`

These are runtime hooks, but they matter to tooling because they feed external dashboards and trace-oriented workflows.

## 7. Current Gaps And Caveats

- Some earlier DX planning docs mixed implemented behavior with future ideas.
- Topology and replay narratives in older docs were more speculative than the current stable surface.
- The runtime tree reorganization changed many runtime source paths; current docs should reference the layered tree rather than the old flat layout.
- Python runtime support exists, but the Python runtime was not structurally reorganized alongside the TS runtime.

## 8. Where To Read Next

- For runtime architecture: [`03-runtime-core.md`](03-runtime-core.md)
- For cluster/control-plane behavior: [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md)
- For language-server details: [`07-lsp.md`](07-lsp.md)
- For test inventory: [`08-test-spec.md`](08-test-spec.md)
