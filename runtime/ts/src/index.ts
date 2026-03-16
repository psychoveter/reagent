// ── R1 Core ─────────────────────────────────────────────────────────
export type { AgentBehavior } from "./contracts/agent-behavior.js";
export type { BehaviorFactory } from "./contracts/behavior-factory.js";
export type { AgentShell, AgentShellStatus, AgentRecordDTO, RoleRunHandle, RoleRunResult, ShellStatusChangeCallback } from "./contracts/agent-shell.js";
export type {
  ProcessRelationKind,
  ProtocolRunStatus,
  ProtocolRunRecord,
  ProtocolRunRef,
  ProtocolRunSnapshot,
  ProtocolRunTracker,
  RoleRunIdentity,
  RoleRunStatus,
  SpawnOwnershipRecord,
  SupervisionStrategy,
} from "./contracts/protocol-run.js";
export { RoleEngine } from "./core/role-engine.js";
export type { RoleEngineInterface, RoleEngineConfig } from "./core/role-engine.js";
export { RoleRun } from "./core/role-run.js";
export type { RoleRunInterface, RoleRunConfig, RoleSpawnRequest, AdvanceHookContext, AdvanceHook } from "./core/role-run.js";
export { AgentShellImpl } from "./core/agent-shell-impl.js";
export type { AgentShellConfig, AgentShellRunLifecycleEvent } from "./core/agent-shell-impl.js";
export { ManagedBehaviorFactory } from "./nodes/managed/managed-behavior-factory.js";
export { CustomBehaviorFactory } from "./nodes/custom-behavior-factory.js";
export type { CustomBehaviorFactoryConfig } from "./nodes/custom-behavior-factory.js";
export { GateBehaviorFactory } from "./nodes/gate/gate-behavior-factory.js";
export type { GateBehaviorFactoryConfig } from "./nodes/gate/gate-behavior-factory.js";
export { PythonBehaviorFactory } from "./nodes/python-behavior-factory.js";
export { ClaudeBehaviorFactory } from "./nodes/claude/claude-behavior-factory.js";
export type { ClaudeBehaviorConfig } from "./nodes/claude/claude-behavior-factory.js";
export {
  loadClaudeLiveAgentNodeConfig,
  resolveClaudeCwd,
} from "./nodes/claude/claude-config.js";
export type {
  ClaudePermissionMode,
  ClaudeToolsConfig,
  ClaudeMcpServersConfig,
  ClaudeLiveAgentSettings,
  ClaudeLiveAgentNodeConfig,
  LoadedClaudeLiveAgentNodeConfig,
} from "./nodes/claude/claude-config.js";
export { ProtocolEngine, durationToMs } from "./core/protocol-engine.js";
export type { ProtocolEvent, AgentResponse, EngineStatus } from "./core/protocol-engine.js";
export { ManagedAgentBehavior } from "./nodes/managed/managed-behavior.js";
export type { ManagedBehaviorConfig } from "./nodes/managed/managed-behavior.js";
/** @deprecated use ManagedAgentBehavior */
export { ManagedAgentBehavior as ManagedAgentAdapter } from "./nodes/managed/managed-behavior.js";
/** @deprecated use ManagedBehaviorConfig */
export type { ManagedBehaviorConfig as ManagedAgentConfig } from "./nodes/managed/managed-behavior.js";
/** @deprecated use AgentBehavior */
export type { AgentBehavior as AgentInterface } from "./contracts/agent-behavior.js";
export { executeZone, createReagentStub } from "./core/zone-executor.js";
export type { ReagentStub } from "./core/zone-executor.js";

// ── Controller & Transport ──────────────────────────────────────────
export { ReagentController } from "./controller/reagent-controller.js";
export type { ReagentControllerConfig } from "./controller/reagent-controller.js";
export { NatsTransport } from "./network/nats-transport.js";
export { NatsCompatTransport } from "./network/nats-compat-transport.js";
export { InMemoryNodeLink, createInMemoryLinkPair } from "./network/inmemory-node-link.js";
export { WsNodeLink, WsNodeLinkServer } from "./network/ws-node-link.js";
export type { WsNodeLinkConfig, WsNodeLinkServerConfig } from "./network/ws-node-link.js";
export { NatsNodeLink } from "./network/nats-node-link.js";
export type { NatsNodeLinkConfig } from "./network/nats-node-link.js";
export * from "./contracts/types.js";
export type { NodeRef, AgentRef, ReagentTransport, NodeLink } from "./contracts/transport.js";
export type { InterceptorFn, InterceptorContext, MessageDirection, TraceHook, AddressPage } from "./contracts/interceptor.js";
export { mergeRoleBindings, resolveRoleBinding, setRoleBinding } from "./controller/role-bindings.js";
export type { RoleBindingMap, RoleBindingResolver, RoleBindingSource, LegacyRoleBindingMap } from "./controller/role-bindings.js";
export { streamingScatter, partitionBranches, partitionedScatter } from "./core/scatter-coordinator.js";
export type { ScatterBranch, ScatterResult, ScatterPartition, ScatterCoordinatorConfig, OnBranchResult, BranchExecutor } from "./core/scatter-coordinator.js";
export { LocalEventBus } from "./controller/local-event-bus.js";
export type { BusEvent, Disposable } from "./controller/local-event-bus.js";

// ── Admin & Debug ───────────────────────────────────────────────────
export { AdminClient } from "./admin/client.js";
export type { AdminResponse, ListAgentsArgs, AdminClientConfig } from "./admin/client.js";
export { NodeControlEndpoint } from "./admin/node-control-endpoint.js";
export type { NodeControlEndpointConfig } from "./admin/node-control-endpoint.js";
export { NodeControlClient } from "./admin/node-control-client.js";
export type { StateStoreProvider } from "./admin/state-store-provider.js";
export { DirectStateStoreProvider, ProxiedStateStoreProvider } from "./admin/state-store-provider.js";
export type { NodeEndpointResolver } from "./admin/node-endpoint-resolver.js";
export { StoreBackedNodeEndpointResolver } from "./admin/node-endpoint-resolver.js";
export { Session, SessionManager } from "./admin/session.js";
export type { SourceMap, SourceMapEntry, CompiledArtifacts, SessionStatus } from "./admin/session.js";
export { DebugInterceptor } from "./admin/debug-interceptor.js";
export type { HeldMessage, DebugInterceptorEvent } from "./admin/debug-interceptor.js";
export { DebugAdvanceHook } from "./admin/debug-advance-hook.js";
export type { StepMode, DebugAdvanceHookEvent } from "./admin/debug-advance-hook.js";
export { DebugController } from "./admin/debug-controller.js";
export type { Breakpoint, ResolvedBreakpoint, DebugStoppedEvent } from "./admin/debug-controller.js";
export { RemoteNode } from "./admin/remote-node.js";
export type { RemoteNodeConfig } from "./admin/remote-node.js";

// ── Gate ────────────────────────────────────────────────────────────
export type { GateTransport } from "./nodes/gate/gate-transport.js";
export { WsGateTransport, StdioGateTransport, HttpGateTransport } from "./nodes/gate/gate-transport.js";
export { GateSession, GateValidationError } from "./nodes/gate/gate-session.js";
export type { GateSessionConfig, GateSessionStatus } from "./nodes/gate/gate-session.js";
export { AsyncQueue } from "./nodes/gate/async-queue.js";
export { McpAgentAdapter } from "./nodes/mcp/mcp-agent-adapter.js";
export type { QueuedEvent } from "./nodes/mcp/mcp-agent-adapter.js";
export { ReagentMcpServer } from "./nodes/mcp/mcp-server.js";
export type { ReagentMcpServerConfig } from "./nodes/mcp/mcp-server.js";

// ── Observability ───────────────────────────────────────────────────
export { createOTelInterceptor, endInstanceSpan } from "./observability/otel-interceptor.js";
export { createOTelTraceHook } from "./observability/otel-trace-hook.js";

// ── Triggers ────────────────────────────────────────────────────────
export { CronAgent, parseCronExpression, cronMatchesDate, parseCronField, nextCronFire } from "./triggers/cron-agent.js";
export type { CronSchedule, CronField } from "./triggers/cron-agent.js";
export { TriggerMatcher } from "./triggers/trigger-matcher.js";
export type { TriggerEntry, InvokeTriggerEntry, EventTriggerEntry, CronTriggerEntry, TriggerCallback, TraceCallback } from "./triggers/trigger-matcher.js";
export { evaluatePolicy, recordTriggerFired, recordTriggerCompleted, createPolicyState, DEFAULT_TRIGGER_POLICY } from "./triggers/trigger-policy.js";
export type { TriggerPolicy, TriggerPolicyState, CircuitState, SuppressionReason } from "./triggers/trigger-policy.js";

// ── Cluster ─────────────────────────────────────────────────────────
export { InMemoryStateStore } from "./cluster/state-store.js";
export type { Lease, StateStore, StoreEntry, StoreValue } from "./cluster/state-store.js";
export { LeaderElection } from "./cluster/leader-election.js";
export type { LeaderElectionConfig } from "./cluster/leader-election.js";
export { bootstrapCluster, parsePeersArg, parseEtcdHostsArg } from "./cluster/cluster-bootstrap.js";
export type { ClusterConfig, ClusterHandle } from "./cluster/cluster-bootstrap.js";
export { EtcdMembership } from "./cluster/etcd-membership.js";
export type { EtcdMembershipConfig } from "./cluster/etcd-membership.js";
export { EtcdManager } from "./cluster/etcd-manager.js";
export type { EtcdManagerConfig } from "./cluster/etcd-manager.js";
export { EtcdStateStore } from "./cluster/etcd-state-store.js";
export type { EtcdStateStoreConfig } from "./cluster/etcd-state-store.js";
export { createDefaultRuntimeConfig } from "./cluster/runtime-config.js";
export type {
  RuntimeConfig,
  StateStoreRuntimeConfig,
  MembershipRuntimeConfig,
  MessagePlaneRuntimeConfig,
  TelemetryRuntimeConfig,
  ControlEndpointRuntimeConfig,
} from "./cluster/runtime-config.js";
export { bootstrapRuntime } from "./cluster/runtime-bootstrap.js";
export type { RuntimeBootstrapHandle } from "./cluster/runtime-bootstrap.js";
