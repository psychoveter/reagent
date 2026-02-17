// Example 08: imports of protocols + invoke
//
// Requirement:
// - A file can import other protocol files (.rg) and code modules (.ts/.py/.kt/.js).
// - Imported protocols become available by name (or alias).
// - Parent protocol can invoke imported protocol from within an agent zone.

import "./lib/derive-dsi-bsi.rg" as derive

protocol TaskExecutionWithImport {
  participants: user [ts], comma [ts], sia [ts]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma {
    $ctx.dsiBsi = reagent.invoke(derive.DeriveDsiBsi, { taskText: $ctx.taskText })
  }

  comma --> sia: SubmitIntent = { }
}
