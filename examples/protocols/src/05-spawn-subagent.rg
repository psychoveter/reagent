message TaskRequest {}
message Greeting {}
message PlanReady {}
message Done {}

// Example 05: spawn subagent (subprotocol / agent creation)
// Intent: comma spawns a subagent to do planning, then continues with result.
// Uses protocol-level `spawns` instead of zone-level reagent.spawn().

protocol SpawnSubagent {
  participants: user [ts], comma [ts], planner [ts]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  comma spawns Subagent({ text: $ctx.taskText }) {
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
