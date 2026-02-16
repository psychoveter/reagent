// Example 08: imports of protocols + invoke
//
// Requirement:
// - A file can import other protocol files.
// - Imported protocols become available by name (or alias).
// - Parent protocol can invoke imported protocol.

import "./lib/derive-dsi-bsi.rg" as derive

protocol TaskExecutionWithImport {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user {
    ctx.taskText = $input.text
  }

  invoke derive.DeriveDsiBsi = {
    input: { taskText: "$ctx.taskText" },
    out: "dsiBsi"
  }

  comma --> sia: SubmitIntent = { }
}

