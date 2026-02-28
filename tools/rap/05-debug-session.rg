// RAP sub-protocol: DebugSession
// Client sends debug commands through orchestrator to an adapter.
// Supports both message-level and state-level stepping.
//
// This is NOT a strict request-response protocol. The command path is
// client → orchestrator → adapter (with an immediate DebugAck back to client).
// Stopped events are pushed asynchronously — they may arrive without a preceding
// DebugCommand (e.g. breakpoint hit on initial run), and a single "continue"
// command may produce zero or multiple Stopped events across different agents.

message DebugCommand {
  sessionId: string
  command: string
  targetAgent?: string
}

message DebugAck {
  sessionId: string
  command: string
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
  participants:
    client [*] initiator,
    orchestrator [*],
    adapter [*]
  trigger on invoke with DebugCommand {
    resolve client = single
    resolve orchestrator = single
    resolve adapter = single
  }

  // Command path: client → orchestrator (ack) → adapter (relay)
  client --> orchestrator: DebugCommand
  orchestrator --> client: DebugAck
  orchestrator --> adapter: DebugCommand

  // Event path: adapter → orchestrator → client (async, N:1 with commands)
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
