// Library protocol file to be imported.

protocol DeriveDsiBsi {
  participants:
    comma [ts] initiator
  trigger on invoke with DeriveRequest {
    resolve comma = single
  }

  comma {
    $ctx.dsiBsi = taskToDsiBsi($ctx.input.taskText)
    reagent.return($ctx.dsiBsi)
  }
}
