// RAP sub-protocol: SubmitDeploySpec
// Client submits a desired-state DeploySpec to ROS for reconciliation.

message SubmitDeploySpecRequest {
  requestId: string
  deploySpec: any   // DeploySpec
}

message SubmitDeploySpecAccepted {
  requestId: string
  deploymentId: string
  planSummary: string
  actionCount: number
  conflictCount: number
}

message SubmitDeploySpecRejected {
  requestId: string
  error: string
  conflicts: any    // ReconciliationConflict[]
}

protocol SubmitDeploySpec {
  participants:
    client [*] initiator,
    ros [*]

  client --> ros: SubmitDeploySpecRequest

  alt (ros --> client: SubmitDeploySpecAccepted) {
  } else (ros --> client: SubmitDeploySpecRejected) {
  }
}

role RAPSubmitDeploySpecSender [*] {
  plays SubmitDeploySpec as client
}

role RAPSubmitDeploySpecReceiver [*] {
  plays SubmitDeploySpec as ros
}
