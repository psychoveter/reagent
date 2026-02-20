// RAP sub-protocol: DeployAgent
// Orchestrator deploys an agent to a runtime adapter (local or remote node).

message Deploy {
  sessionId: string
  agentName: string
  roleIR: any
  graphs: any[]
  roleToAgent: any
}

message Deployed {
  agentName: string
  nodeId: string
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

role RAPDeployer [*] {
  plays DeployAgent as orchestrator
}

role RAPNode [*] {
  plays DeployAgent as adapter
}
