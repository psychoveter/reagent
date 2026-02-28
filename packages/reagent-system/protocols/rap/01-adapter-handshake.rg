// RAP sub-protocol: AdapterHandshake
// Runtime adapter registers with the orchestrator.
// The adapter announces its capabilities; the orchestrator accepts or rejects.

message Register {
  nodeId: string
  capabilities?: string[]
  maxAgents?: number
  supportedLangs: string[]
}

message Accepted {
  nodeId: string
}

message Rejected {
  reason: string
}

protocol AdapterHandshake {
  participants:
    adapter [*] initiator,
    orchestrator [*]
  trigger on invoke with Register {
    resolve adapter = single
    resolve orchestrator = single
  }

  adapter --> orchestrator: Register

  alt (orchestrator --> adapter: Accepted) {
  } else (orchestrator --> adapter: Rejected) {
  }
}

role RAPAdapter [*] {
  plays AdapterHandshake as adapter
}

role RAPOrchestrator [*] {
  plays AdapterHandshake as orchestrator
}
