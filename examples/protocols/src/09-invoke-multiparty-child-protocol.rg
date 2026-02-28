// Example 09: invoke a multi-party child protocol
// Uses protocol-level `invokes` with role mapping for multi-party child.

message TaskRequest {}
message Done {}
message Failed {}

import "./lib/validate-intent-with-sia.rg" as v

protocol TaskExecutionWithMultipartyChild {
  participants:
    user [ts] initiator,
    comma [ts],
    sia [*]
  trigger on invoke with TaskRequest {
    resolve user = single
    resolve comma = single
    resolve sia = single
  }

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

role UserRole [ts] {
  plays TaskExecutionWithMultipartyChild as user
}

role CommaRole [ts] {
  plays TaskExecutionWithMultipartyChild as comma
}

role SiaRole [*] {
  plays TaskExecutionWithMultipartyChild as sia
}

agent User runs UserRole
agent Comma runs CommaRole
agent Sia runs SiaRole
