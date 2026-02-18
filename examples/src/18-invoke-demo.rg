// Example 18: child protocol invocation (reagent.invoke / reagent.return)
//
// ResponderAgent invokes a child protocol (ComputeSquare) via reagent.invoke().
// ComputeSquare is a single-agent protocol that computes the square of input
// and returns via reagent.return(). The parent receives the value synchronously.

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
    $ctx.value = 7
  }
  caller --> responder: ComputeRequest = {
    onSend {
      $ctx.msg.value = $ctx.value
    }
    onReceive {
      $ctx.receivedValue = $ctx.msg.value
    }
  }

  responder {
    $ctx.squared = reagent.invoke("ComputeSquare", { value: $ctx.receivedValue })
  }

  responder --> caller: ComputeResult = {
    onSend {
      $ctx.msg.squared = $ctx.squared
    }
    onReceive {
      $self.lastResult = $ctx.msg.squared
    }
  }
}

agent CallerAgent [ts] {
  plays InvokeDemo as caller

  init {
    $self.lastResult = 0
  }
}

agent ResponderAgent [ts] {
  plays InvokeDemo as responder
  plays ComputeSquare as worker
}
