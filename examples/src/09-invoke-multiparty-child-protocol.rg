// Example 09: invoke a multi-party child protocol
//
// Requirement: invoked protocol can have multiple participants (comma + sia),
// and is invoked from a parent protocol that has its own participants (user + comma + sia).
//
// Semantics:
// - reagent.invoke() is zone-only: comma invokes the child, so comma is the implicit invoker.
// - The child protocol runs comma ↔ sia interaction internally.
// - Parent routes result via $ctx and messages.
//
// Note: no protocol-level `if/else`. Condition branching happens inside agent zone.

import "./lib/validate-intent-with-sia.rg" as v

protocol TaskExecutionWithMultipartyChild {
  participants: user [ts], comma [ts], sia [ts]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma {
    $ctx.intent = taskToDsiBsi($ctx.taskText)
    $ctx.validation = reagent.invoke(v.ValidateIntentWithSia, { sia: sia }, { intent: $ctx.intent })
  }

  // Condition branching is inside agent zone; result is communicated via messages.
  comma {
    if ($ctx.validation.ok) {
      $ctx.outcome = "done"
    } else {
      $ctx.outcome = "failed"
    }
  }

  alt ($ctx.outcome == "done") {
    comma --> user: Done = { }
  } else {
    comma --> user: Failed = { }
  }
}
