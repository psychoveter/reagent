message TaskRequest {}
message SubmitIntent {}

// Example 08: imports of protocols + invokes
// Uses protocol-level `invokes` with imported protocol.

import "./lib/derive-dsi-bsi.rg" as derive

protocol TaskExecutionWithImport {
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

  comma invokes derive.DeriveDsiBsi({ taskText: $ctx.taskText }) -> $ctx.dsiBsi

  comma --> sia: SubmitIntent = { }
}

role UserRole [ts] {
  plays TaskExecutionWithImport as user
}

role CommaRole [ts] {
  plays TaskExecutionWithImport as comma
}

role SiaRole [*] {
  plays TaskExecutionWithImport as sia
}

agent User runs UserRole
agent Comma runs CommaRole
agent Sia runs SiaRole
