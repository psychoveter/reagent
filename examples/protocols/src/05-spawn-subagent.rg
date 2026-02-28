message TaskRequest {}
message Greeting {}
message PlanReady {}
message Done {}

// Example 05: async invokes (fire-and-forget sub-protocol with role mapping)
// Intent: comma launches a background sub-protocol for planning, then continues.
// Uses protocol-level `async invokes` for non-blocking sub-protocol call.

protocol SpawnSubagent {
  participants:
    user [ts] initiator,
    comma [ts],
    planner [ts]
  trigger on invoke with TaskRequest {
    resolve user = single
    resolve comma = single
    resolve planner = single
  }

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  comma async invokes Subagent({ text: $ctx.taskText }) {
    planner: planner
  }

  planner --> comma: PlanReady = {
    onReceive {
      $ctx.dsi = $ctx.msg.dsi
      $ctx.bsi = $ctx.msg.bsi
    }
  }

  comma --> user: Done = {
    onSend {
      $ctx.msg.ok = true
    }
  }
}

role UserRole [ts] {
  plays SpawnSubagent as user
}

role CommaRole [ts] {
  plays SpawnSubagent as comma
}

role PlannerRole [ts] {
  plays SpawnSubagent as planner
}

agent User runs UserRole
agent Comma runs CommaRole
agent Planner runs PlannerRole
