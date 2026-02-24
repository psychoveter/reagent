// Example 18: child protocol invocation (protocol-level invokes / reagent.return)
// Uses protocol-level invokes instead of zone-level reagent.invoke().

message ComputeRequest {}
message ComputeResult {}

protocol ComputeSquare {
  participants: worker [ts]
  initiator: worker
  input: ComputeRequest

  worker {
    $ctx.result = $ctx.input.value * $ctx.input.value
    reagent.return($ctx.result)
  }
}

protocol InvokeDemo {
  participants: caller [ts], responder [ts]
  initiator: caller

  caller {
    $flow.value = 7
  }
  caller --> responder: ComputeRequest = {
    onSend {
      $ctx.msg.value = $flow.value
    }
    onReceive {
      $ctx.receivedValue = $ctx.msg.value
    }
  }

  responder invokes ComputeSquare({ value: $ctx.receivedValue }) -> $flow.squared

  responder --> caller: ComputeResult = {
    onSend {
      $ctx.msg.squared = $flow.squared
    }
    onReceive {
      $self.lastResult = $ctx.msg.squared
    }
  }
}

role CallerRole [ts] {
  plays InvokeDemo as caller

  init {
    $self.lastResult = 0
  }
}

role ResponderRole [ts] {
  plays InvokeDemo as responder
  plays ComputeSquare as worker
}

agent CallerAgent runs CallerRole
agent ResponderAgent runs ResponderRole
