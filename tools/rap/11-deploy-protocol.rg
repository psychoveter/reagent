// RAP sub-protocol: DeployProtocol
// ROS sends IR artifacts to an RC, which runs canDeploy() and registers the protocol.

message DeployProtocolRequest {
  requestId: string
  protocolName: string
  version: string
  fingerprints: any   // ProtocolFingerprint
  dependencies: any   // ProtocolDependency[]
  irGraphs: any       // Serialized IR artifacts
}

message DeployProtocolSuccess {
  requestId: string
  protocolName: string
  version: string
}

message DeployProtocolFailed {
  requestId: string
  protocolName: string
  error: string
}

protocol DeployProtocol {
  participants: ros [*], rc [*]
  initiator: ros

  ros --> rc: DeployProtocolRequest

  alt (rc --> ros: DeployProtocolSuccess) {
  } else (rc --> ros: DeployProtocolFailed) {
  }
}

role RAPDeployProtocolSender [*] {
  plays DeployProtocol as ros
}

role RAPDeployProtocolReceiver [*] {
  plays DeployProtocol as rc
}
