// Example 12: role-centric multi-protocol participation
//
// Role is the primary behavioral contract: plays, persistent state ($self), lifecycle events.
// Agent is a thin deployment binding: "agent X runs RoleName".

message TaskRequest {}
message SubmitIntent {}
message Ping {}
message Pong {}

import "./lib/derive-dsi-bsi.rg" as derive

protocol TaskExecution {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma invokes derive.DeriveDsiBsi({ taskText: $ctx.taskText }) -> $ctx.dsiBsi

  comma {
    $self.lastDsiBsi = $ctx.dsiBsi
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
  }
}

protocol HealthCheck {
  participants: monitor [*], comma [ts]
  initiator: monitor
  input: Ping

  monitor --> comma: Ping = { }
  comma --> monitor: Pong = {
    onSend {
      $ctx.msg.tasksCompleted = $self.tasksCompleted
      $ctx.msg.ready = $self.ready
    }
  }
}

role CommaRole [ts] {
  plays TaskExecution as comma
  plays HealthCheck as comma

  init {
    $self.ready = true
    $self.tasksCompleted = 0
  }

  on protocolCompleted(TaskExecution) {
    $self.tasksCompleted += 1
    reagent.emit("AgentStats", { completed: $self.tasksCompleted })
  }

  on protocolFailed(TaskExecution) {
    $self.lastError = $ctx.error
  }

  on protocolStarted(HealthCheck) {
    $self.lastHealthCheck = Date.now()
  }
}

agent Comma runs CommaRole
