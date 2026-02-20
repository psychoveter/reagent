message TaskRequest {}
message Greeting {}
message PlanReady {}
message Done {}

// Example 05: spawn subagent (subprotocol / agent creation)
// Intent: comma spawns a subagent to do planning, then continues with result.
// Uses protocol-level `spawn` instead of zone-level reagent.spawn().

protocol SpawnSubagent {
  participants: user [ts], comma [ts], planner [ts]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  spawn Subagent({ text: $flow.taskText }) as comma {
    planner: planner
  }

  planner --> comma: PlanReady = {
    onReceive {
      $flow.dsi = $ctx.msg.dsi
      $flow.bsi = $ctx.msg.bsi
    }
  }

  comma --> user: Done = {
    onSend {
      $ctx.msg.ok = true
    }
  }
}
