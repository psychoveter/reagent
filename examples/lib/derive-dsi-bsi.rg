// Library protocol file to be imported.

protocol DeriveDsiBsi {
  participants: comma
  initiator: comma
  input: DeriveRequest

  comma {
    const dsiBsi = taskToDsiBsi(ctx.taskText)
    ctx.dsiBsi = dsiBsi
  }
}

