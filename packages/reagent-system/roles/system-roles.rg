// System roles for Reagent self-hosting infrastructure

role OrchestratorRole [ts] {
  plays Orchestrator in AdapterHandshake
  plays Orchestrator in CompileRequest
  plays Orchestrator in DeployProtocol
  plays Orchestrator in RunProtocol
  plays Orchestrator in DebugSession
  plays Orchestrator in InspectState
  plays Orchestrator in ShutdownNode
  plays Orchestrator in TraceStream
  plays Orchestrator in TriggerProtocol
}

role DebugRole [ts] {
  plays Debugger in DebugSession
  plays Inspector in InspectState
}

role ReconcilerRole [ts] {
  plays Reconciler in DeployProtocol
}

role DiscoveryRole [ts] {
  plays Prober in Ping
  plays Target in Ping
  plays Requester in IndirectPing
  plays Relay in IndirectPing
  plays Suspect in IndirectPing
  plays Source in MembershipUpdate
  plays Peer in MembershipUpdate
}

agent ROS runs OrchestratorRole
agent DebugAgent runs DebugRole
agent ReconcilerAgent runs ReconcilerRole
agent DiscoveryAgent runs DiscoveryRole
