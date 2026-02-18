// Example 12: role-centric multi-protocol participation
//
// Requirement:
// - A role is the primary behavioral contract: it declares which protocols
//   to play, holds persistent state ($self), and reacts to lifecycle events.
// - An agent is a thin deployment binding: "agent X runs RoleName".
// - Roles support `extends` for single inheritance.
//
// Semantics:
// - `role Name [langTag] { ... }` declares the behavioral contract.
// - `plays Proto as roleName` inside a role binds a protocol participation.
// - `init { ... }` runs once when the agent running this role starts.
// - `on <event>(<proto?>) { ... }` runs on lifecycle events.
// - $self is the role's persistent state, accessible in init, on, and protocol zones.
// - $ctx remains scoped to a protocol instance as before.
// - `agent Name runs RoleName` is a deployment binding.

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

  comma {
    $ctx.dsiBsi = reagent.invoke(derive.DeriveDsiBsi, { taskText: $ctx.taskText })
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
