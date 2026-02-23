// RAP sub-protocol: ListProtocols
// ROS queries an RC node for its registered protocol list.
// Used to build RegistryView for reconciliation.

message ListProtocolsRequest {
  requestId: string
}

message ListProtocolsResponse {
  requestId: string
  nodeId: string
  protocols: any  // Array<{ name, version, fingerprints, dependencies, boundAgents }>
}

protocol ListProtocols {
  participants: ros [*], rc [*]
  initiator: ros

  ros --> rc: ListProtocolsRequest
  rc --> ros: ListProtocolsResponse
}

role RAPListProtocolsSender [*] {
  plays ListProtocols as ros
}

role RAPListProtocolsReceiver [*] {
  plays ListProtocols as rc
}
