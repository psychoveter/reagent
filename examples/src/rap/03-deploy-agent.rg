// RAP sub-protocol: DeployAgent
// Orchestrator deploys an agent to a runtime adapter.

message Deploy {
  sessionId: string
  agentIR: any
  graphs: any[]
  roleToAgent: any
  natsUrl: string
}

message Deployed {
  agentName: string
}

message DeployFailed {
  agentName: string
  error: string
}

protocol DeployAgent {
  participants: orchestrator [*], adapter [*]
  initiator: orchestrator
  input: Deploy

  orchestrator --> adapter: Deploy

  alt (adapter --> orchestrator: Deployed) {
  } else (adapter --> orchestrator: DeployFailed) {
  }
}
