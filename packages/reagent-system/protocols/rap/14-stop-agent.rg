// RAP sub-protocol: StopAgent
// ROS requests an RC to gracefully stop a running agent.

message StopAgentRequest {
  requestId: string
  agentName: string
}

message StopAgentSuccess {
  requestId: string
  agentName: string
}

message StopAgentFailed {
  requestId: string
  agentName: string
  error: string
}

protocol StopAgent {
  participants: ros [*], rc [*]
  initiator: ros

  ros --> rc: StopAgentRequest

  alt (rc --> ros: StopAgentSuccess) {
  } else (rc --> ros: StopAgentFailed) {
  }
}

role RAPStopAgentSender [*] {
  plays StopAgent as ros
}

role RAPStopAgentReceiver [*] {
  plays StopAgent as rc
}
