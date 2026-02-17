// Library protocol file to be imported.

protocol DeriveDsiBsi {
  participants: comma [ts]
  initiator: comma
  input: DeriveRequest

  comma {
    const dsiBsi = taskToDsiBsi($ctx.input.taskText)
    $ctx.dsiBsi = dsiBsi
    reagent.return($ctx.dsiBsi)
  }
}
