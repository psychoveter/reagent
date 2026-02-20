// RAP sub-protocol: DebugSession
// Client sends debug commands through orchestrator to an adapter.
// Supports both message-level and state-level stepping.

message DebugCommand {
  sessionId: string
  command: string
  targetAgent?: string
}

message Stopped {
  sessionId: string
  agentName: string
  stateId: string
  stateKind: string
  reason: string
  ctx?: any
  self?: any
}

protocol DebugSession {
  participants: client [*], orchestrator [*], adapter [*]
  initiator: client
  input: DebugCommand

  client --> orchestrator: DebugCommand
  orchestrator --> adapter: DebugCommand

  adapter --> orchestrator: Stopped
  orchestrator --> client: Stopped
}

role RAPDebugClient [*] {
  plays DebugSession as client
}

role RAPDebugRelay [*] {
  plays DebugSession as orchestrator
}

role RAPDebugTarget [*] {
  plays DebugSession as adapter
}
