// Example 12: agent definition — multi-protocol participation with roles
//
// Requirement:
// - An agent is a concrete entity that plays roles across multiple protocols.
// - Agent has its own persistent state ($self), distinct from per-protocol $ctx.
// - Agent can react to protocol lifecycle events (started, completed, failed).
// - Agent can start/stop protocols from within lifecycle handlers.
// - A `role` bundles multiple `plays` into a named interface contract.
// - An agent uses `implements RoleName` to adopt all plays from a role.
//
// Semantics:
// - `agent Name [langTag]` declares a named agent with a host language.
// - `role Name { plays ... }` defines a multi-protocol interface.
// - `implements RoleName` in an agent expands to the role's plays bindings.
// - `plays Proto as role` can still be used alongside implements.
// - `init { ... }` runs once when the agent starts.
// - `on <event>(<proto?>) { ... }` runs on lifecycle events.
// - $self is the agent's own state, accessible in init, on, and protocol zones.
// - $ctx remains scoped to a protocol instance as before.

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

role CommaRole {
  plays TaskExecution as comma
  plays HealthCheck as comma
}

agent Comma [ts] {
  implements CommaRole

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
