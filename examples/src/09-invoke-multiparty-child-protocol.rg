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
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma {
    $flow.intent = taskToDsiBsi($flow.taskText)
  }

  comma invokes v.ValidateIntentWithSia({ intent: $flow.intent }) {
    sia: sia
  } -> $flow.validation

  alt ($flow.validation.ok == true) {
    comma --> user: Done = { }
  } else {
    comma --> user: Failed = { }
  }
}
