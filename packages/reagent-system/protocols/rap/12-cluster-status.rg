// RAP sub-protocol: ClusterStatus
// Client or tooling queries ROS for aggregated cluster view.

message ClusterStatusRequest {
  requestId: string
}

message ClusterStatusResponse {
  requestId: string
  nodes: any       // RegistryNodeInfo[]
  protocols: any   // RegistryProtocolEntry[]
  agents: any      // RegistryAgentEntry[] — includes tags, capabilities, labels, spawnedBy
  timestamp: number
}

protocol ClusterStatus {
  participants:
    client [*] initiator,
    ros [*]

  client --> ros: ClusterStatusRequest
  ros --> client: ClusterStatusResponse
}

role RAPClusterStatusRequester [*] {
  plays ClusterStatus as client
}

role RAPClusterStatusProvider [*] {
  plays ClusterStatus as ros
}
