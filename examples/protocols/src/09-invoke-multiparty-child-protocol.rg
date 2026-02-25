// Example 09: invoke a multi-party child protocol
// Uses protocol-level `invokes` with role mapping for multi-party child.

message TaskRequest {}
message Done {}
message Failed {}

import "./lib/validate-intent-with-sia.rg" as v

protocol TaskExecutionWithMultipartyChild {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma {
    $ctx.intent = taskToDsiBsi($ctx.taskText)
  }

  comma invokes v.ValidateIntentWithSia({ intent: $ctx.intent }) {
    sia: sia
  } -> $ctx.validation

  alt ($ctx.validation.ok == true) {
    comma --> user: Done = { }
  } else {
    comma --> user: Failed = { }
  }
}
