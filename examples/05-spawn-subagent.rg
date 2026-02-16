// Example 05: spawn subagent (subprotocol / agent creation)
// Intent: comma spawns a subagent to do planning (DSI/BSI), then continues with result.
// Roles: user, comma, planner
//
// Required acts: spawn/subagent creation, child instance correlation, await child completion.

protocol SpawnSubagent {
  participants: user, comma, planner
  initiator: user
  input: TaskRequest

  user {
    ctx.taskText = $input.text
  }
  comma --> user: Greeting = { }

  spawn planner as Subagent = {
    role: "planner",
    input: { text: "$ctx.taskText" },
    onSpawn: { call: "comma.onSpawnPlanner", args: { parent: "$instanceId" } }
  }

  planner --> comma: PlanReady = {
    onReceive: { call: "comma.onPlanReady", args: { dsi: "$msg.dsi", bsi: "$msg.bsi" } }
  }

  comma --> user: Done = { onSend: { call: "comma.replyDone", args: { ok: true } } }
}

