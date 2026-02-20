message TaskRequest {}
message SubmitIntent {}

// Example 08: imports of protocols + invoke
// Uses protocol-level `invoke` with imported protocol.

import "./lib/derive-dsi-bsi.rg" as derive

protocol TaskExecutionWithImport {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  invoke derive.DeriveDsiBsi({ taskText: $flow.taskText }) as comma -> $flow.dsiBsi

  comma --> sia: SubmitIntent = { }
}
