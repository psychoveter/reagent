message TaskRequest {}
message Greeting {}
message PlanReady {}
message Done {}

// Example 05: spawn subagent (subprotocol / agent creation)
// Intent: comma spawns a subagent to do planning (DSI/BSI), then continues with result.
// Roles: user [ts], comma [ts], planner [ts]
//
// spawn is zone-only (like invoke). It creates an independent (fire-and-forget) protocol instance.
// The spawned agent communicates back via messages.

protocol SpawnSubagent {
  participants: user [ts], comma [ts], planner [ts]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  comma {
    $ctx.plannerHandle = reagent.spawn(Subagent, { planner: planner }, { text: $ctx.taskText })
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
