// Example 09: invoke a multi-party child protocol
//
// Requirement: invoked protocol can have multiple participants (comma + sia),
// and is invoked from a parent protocol that has its own participants (user + comma + sia).
//
// Semantics we want to capture:
// - Parent invokes child protocol by name (possibly imported).
// - Child runs its own message exchanges between its participants.
// - Parent waits for child completion and consumes its outputs (ctx bindings).
//
// NOTE: invoke syntax is provisional; this file is a design fixture, not a final grammar test.

import "./lib/validate-intent-with-sia.rg" as v

protocol TaskExecutionWithMultipartyChild {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user {
    ctx.taskText = $input.text
  }
  comma {
    // derive intent (DSI/BSI) locally
    ctx.intent = taskToDsiBsi(ctx.taskText)
  }

  // Invoke multi-party child protocol (comma ↔ sia).
  // Proposed: child shares participants with parent (comma, sia), and runs inside its own instance.
  invoke v.ValidateIntentWithSia = {
    input: { intent: "$ctx.intent" },
    out: "validation"
  }

  alt (ctx.validation.ok == true) {
    comma --> user: Done = { }
  } else {
    comma --> user: Failed = { }
  }
}

