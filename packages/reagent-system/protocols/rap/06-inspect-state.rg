// RAP sub-protocol: InspectState
// Client queries runtime state of an agent through the orchestrator.

message GetState {
  sessionId: string
  agentName: string
}

message StateSnapshot {
  agentName: string
  stateId?: string
  stateKind?: string
  ctx?: any
  self: any
  pendingMessages?: string[]
  recentTraces: any[]
  heldMessages?: any[]
  instanceStatuses?: any
  resolveBindings?: any   // Record<role, { policy: ResolvePolicyIR; boundAgents: string[] }>
  participants?: any      // ParticipantIR[] — current participant metadata for this instance
}

message InspectError {
  agentName?: string
  error: string
}

protocol InspectState {
  participants:
    client [*] initiator,
    orchestrator [*],
    adapter [*]
  trigger on invoke with GetState {
    resolve client = single
    resolve orchestrator = single
    resolve adapter = single
  }

  client --> orchestrator: GetState
  orchestrator --> adapter: GetState

  alt (adapter --> orchestrator: StateSnapshot) {
    orchestrator --> client: StateSnapshot
  } else (adapter --> orchestrator: InspectError) {
    orchestrator --> client: InspectError
  }
}

role RAPInspectClient [*] {
  plays InspectState as client
}

role RAPInspectRelay [*] {
  plays InspectState as orchestrator
}

role RAPInspectTarget [*] {
  plays InspectState as adapter
}
