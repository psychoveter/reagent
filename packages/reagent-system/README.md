# @reagent/system

Reagent system protocols and roles for self-hosting infrastructure.

## Overview

This package contains the **Reagent Administration Protocol (RAP)** — a set of
`.rg` protocol definitions that allow Reagent to manage its own runtime:
compiling sources, deploying agents, running protocols, debugging, tracing, and
cluster orchestration.

It also defines the **system roles** that compose these protocols into concrete
agent identities (ROS, DebugAgent, ReconcilerAgent, DiscoveryAgent).

## Structure

```
reagent-system/
├── reagent.json                 # Package manifest
├── protocols/
│   └── rap/                     # RAP sub-protocols
│       ├── 01-adapter-handshake.rg
│       ├── 02-compile-request.rg
│       ├── 03-deploy-agent.rg
│       ├── 04-run-protocol.rg
│       ├── 05-debug-session.rg
│       ├── 06-inspect-state.rg
│       ├── 07-set-breakpoints.rg
│       ├── 08-trace-stream.rg
│       ├── 09-trigger-protocol.rg
│       ├── 10-list-protocols.rg
│       ├── 11-deploy-protocol.rg
│       ├── 12-cluster-status.rg
│       ├── 13-submit-deploy-spec.rg
│       └── 14-stop-agent.rg
└── roles/
    └── system-roles.rg          # System agent/role definitions
```

## Protocols (RAP)

| # | Protocol | Purpose |
|---|----------|---------|
| 01 | AdapterHandshake | Runtime adapter registers with the orchestrator |
| 02 | CompileRequest | Compile `.rg` source to IR |
| 03 | DeployAgent | Deploy an agent to a runtime node |
| 04 | RunProtocol | Start a protocol instance |
| 05 | DebugSession | Debug commands and breakpoint events |
| 06 | InspectState | Query live agent state |
| 07 | SetBreakpoints | Configure breakpoints |
| 08 | TraceStream | Real-time trace event streaming |
| 09 | TriggerProtocol | Trigger protocol on a deployed agent |
| 10 | ListProtocols | Query node for registered protocols |
| 11 | DeployProtocol | Push IR artifacts to a node |
| 12 | ClusterStatus | Aggregated cluster view |
| 13 | SubmitDeploySpec | Submit desired-state deploy spec for reconciliation |
| 14 | StopAgent | Gracefully stop a running agent |

## System Roles

- **OrchestratorRole** — composes all orchestrator-side protocol participations into a single role, run by the **ROS** agent.
- **DebugRole** — debug and inspect capabilities, run by **DebugAgent**.
- **ReconcilerRole** — deployment reconciliation, run by **ReconcilerAgent**.
- **DiscoveryRole** — placeholder for gossip-based node discovery (Wave 3.2), run by **DiscoveryAgent**.
