                                                                                                              // Example 15: loop + wait demo for runtime E2E tests
//
// Tests:
//   T6: Loop executes N iterations then exits
//   T7: Wait delays execution by specified duration
//   T8: $self accumulates state across loop iterations
//
// Protocol: poller sends repeated Ping to responder.
// Responder replies with Pong. Loop runs 3 times, with a short wait between iterations.
// After loop exits, poller sends Done.

message Ping {}
message Pong {}
message Done {}

protocol LoopWaitDemo {
  participants: poller [ts], responder [ts]
  initiator: poller
  input: Start

  poller {
    $ctx.iteration = 0
    $ctx.maxIterations = 3
  }

  loop ($ctx.iteration < $ctx.maxIterations) {
    poller {
      $ctx.iteration = $ctx.iteration + 1
    }

    poller --> responder: Ping = {
      onSend {
        $ctx.msg.seq = $ctx.iteration
      }
      onReceive {
        $ctx.lastSeq = $ctx.msg.seq
      }
    }

    responder {
      $self.pingsReceived = ($self.pingsReceived || 0) + 1
      $ctx.pongData = "pong:" + $ctx.lastSeq
    }

    responder --> poller: Pong = {
      onSend {
        $ctx.msg.data = $ctx.pongData
      }
      onReceive {
        $ctx.lastPong = $ctx.msg.data
      }
    }

    wait 50ms
  }

  poller --> responder: Done = {
    onSend {
      $ctx.msg.totalIterations = $ctx.iteration
    }
    onReceive {
      $ctx.totalIterations = $ctx.msg.totalIterations
    }
  }

  responder {
    $self.lastTotalIterations = $ctx.totalIterations
  }
}

agent PollerAgent [ts] {
  plays LoopWaitDemo as poller

  init {
    $self.ready = true
    $self.protocolsCompleted = 0
  }

  on protocolCompleted(LoopWaitDemo) {
    $self.protocolsCompleted = ($self.protocolsCompleted || 0) + 1
  }
}

agent ResponderAgent [ts] {
  plays LoopWaitDemo as responder

  init {
    $self.pingsReceived = 0
  }

  on protocolCompleted(LoopWaitDemo) {
    $self.lastCompletedAt = Date.now()
  }
}
