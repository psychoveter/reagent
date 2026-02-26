// RAP sub-protocol: TriggerProtocol
// Orchestrator triggers a protocol instance on a specific agent hosted by an adapter.
// Used after DeployAgent to start execution on remote nodes.

message TriggerProtocol {
  agentName: string
  instanceId: string
  protocolName: string
  input?: any
  roleToAgent?: any
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
  participants: orchestrator [*], adapter [*]
  initiator: orchestrator
  input: TriggerProtocol

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
