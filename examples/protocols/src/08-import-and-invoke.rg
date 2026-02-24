message TaskRequest {}
message SubmitIntent {}

// Example 08: imports of protocols + invokes
// Uses protocol-level `invokes` with imported protocol.

import "./lib/derive-dsi-bsi.rg" as derive

protocol TaskExecutionWithImport {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma invokes derive.DeriveDsiBsi({ taskText: $flow.taskText }) -> $flow.dsiBsi

  comma --> sia: SubmitIntent = { }
}
