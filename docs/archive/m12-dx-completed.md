## M12-DX: tooling updates for resolve + spawn — COMPLETED

All tasks (P.1–P.8, T.1a–T.15) completed. Adapted RAP, DAP, VSCode extension, and LSP
to the new participant model, resolve policies, agent metadata, and spawn lifecycle.

### Foundation (P.1–P.8)

| # | Task | Status |
|---|------|--------|
| P.1 | Runtime type sync: `ParticipantIR`, `resolveMap`, `AgentRegistrationIR`, `ResolvePolicyIR` in `runtime/ts/src/contracts/types.ts` | ✅ Done |
| P.2 | RegistryView metadata: `RegistryAgentEntry` extended with `tags`, `capabilities`, `labels`, `spawnedBy` | ✅ Done |
| P.3 | TraceHook wiring: `ResolveCompleted`, `SpawnStarted/Completed/Failed`, `TriggerDedupSkipped` | ✅ Done |
| P.4 | Diagram participant metadata: `binding`, `cardinality` in `Participant` type | ✅ Done |
| P.5 | LSP dev infrastructure: launch.json, test harness, structured logging, health-check | ✅ Done |
| P.6 | DebugResolveHook at RC level | ✅ Done |
| P.7 | DAP breakpoint ID allocation, thread lifecycle events | ✅ Done |
| P.8 | Instance tree tracking (parentInstanceId, spawn parent-child in ROS) | ✅ Done |

### RAP wire protocol (T.1–T.6)

| # | Task | Status |
|---|------|--------|
| T.1a | DeployProtocol payload: `participants`, `resolveMap`, `agentRegistrations` | ✅ Done |
| T.1b | Internal Deploy message to adapter nodes: `agentRegistrations` propagated | ✅ Done |
| T.2 | TriggerProtocol: `resolveOverrides` for dev/test | ✅ Done |
| T.3 | ClusterStatus: agent metadata in response | ✅ Done |
| T.4 | InspectState: `resolveBindings`, `participants` in StateSnapshot | ✅ Done |
| T.5 | ListAgents: new RAP sub-protocol with filter expression DSL (`15-list-agents.rg`) | ✅ Done |
| T.6 | TraceStream: documented new event kinds | ✅ Done |

### LSP (T.7–T.11)

| # | Task | Status |
|---|------|--------|
| T.7 | Workspace indexing + cross-file go-to-def + cross-file completion | ✅ Done |
| T.8 | Semantic tokens provider (11 token types, 4 modifiers) | ✅ Done |
| T.10 | Completion: participant modifiers, resolve steps, filter predicates, trigger syntax | ✅ Done |
| T.11 | Diagnostics: missing resolve, cardinality errors, pipeline validation, trigger completeness | ✅ Done |

### VSCode extension (T.9, T.12a/b)

| # | Task | Status |
|---|------|--------|
| T.9 | TextMate grammar: new keywords (done as part of M10 Phase 4a) | ✅ Done |
| T.12a | Protocol View: participant modifier badges (initiator ▶, dynamic "dyn", many "∗") | ✅ Done |
| T.12b | Protocol View: live resolve annotations (agent bindings from cluster state) | ✅ Done |

### DAP debug adapter (T.13–T.15)

| # | Task | Status |
|---|------|--------|
| T.13 | Resolve breakpoint type: pause after pipeline evaluation, synthetic stack frame | ✅ Done |
| T.14 | Variable scopes: resolve, participants, registry | ✅ Done |
| T.15 | Spawned agents as DAP threads: SpawnStarted/Failed lifecycle | ✅ Done |
