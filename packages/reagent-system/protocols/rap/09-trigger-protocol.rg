// RAP sub-protocol: TriggerProtocol
// Orchestrator triggers a protocol instance on a specific agent hosted by an adapter.
// Used after DeployAgent to start execution on remote nodes.

message TriggerProtocol {
  agentName: string
  instanceId: string
  protocolName: string
  input?: any
  roleToAgent?: any
  resolveOverrides?: any  // Record<string, ResolvePolicyIR> — dev/test override for resolve pipelines
}

message TriggerAck {
  agentName: string
  instanceId: string
}

message TriggerFailed {
  agentName: string
  instanceId: string
  error: string
}

protocol TriggerProtocol {
  participants:
    orchestrator [*] initiator,
    adapter [*]
  trigger on invoke with TriggerProtocol {
    resolve orchestrator = single
    resolve adapter = single
  }

  orchestrator --> adapter: TriggerProtocol

  alt (adapter --> orchestrator: TriggerAck) {
  } else (adapter --> orchestrator: TriggerFailed) {
  }
}

role RAPTriggerSender [*] {
  plays TriggerProtocol as orchestrator
}

role RAPTriggerReceiver [*] {
  plays TriggerProtocol as adapter
}
