// Example 16: par (parallel branches) demo for runtime E2E tests
//
// Tests:
//   T9: Two parallel branches both complete, join fires once
//   T10: Parallel branches interact with different agents
//
// Protocol: coordinator sends tasks to two workers in parallel,
// waits for both to complete (join), then sends a summary.

message TaskA {}
message TaskB {}
message ResultA {}
message ResultB {}
message Summary {}

protocol ParDemo {
  participants: coordinator [ts], workerA [ts], workerB [ts]
  initiator: coordinator
  input: Start

  coordinator {
    $ctx.startedAt = Date.now()
  }

  coordinator --> workerA: TaskA = {
    onSend {
      $ctx.msg.label = "alpha"
    }
    onReceive {
      $ctx.taskLabel = $ctx.msg.label
    }
  }
  coordinator --> workerB: TaskB = {
    onSend {
      $ctx.msg.label = "beta"
    }
    onReceive {
      $ctx.taskLabel = $ctx.msg.label
    }
  }

  par {
    workerA {
      $ctx.resultA = "done:" + $ctx.taskLabel
      $self.tasksCompleted = ($self.tasksCompleted || 0) + 1
    }
    workerA --> coordinator: ResultA = {
      onSend {
        $ctx.msg.result = $ctx.resultA
      }
      onReceive {
        $ctx.resultA = $ctx.msg.result
      }
    }
  } and {
    workerB {
      $ctx.resultB = "done:" + $ctx.taskLabel
      $self.tasksCompleted = ($self.tasksCompleted || 0) + 1
    }
    workerB --> coordinator: ResultB = {
      onSend {
        $ctx.msg.result = $ctx.resultB
      }
      onReceive {
        $ctx.resultB = $ctx.msg.result
      }
    }
  }

  coordinator {
    $ctx.summary = $ctx.resultA + "+" + $ctx.resultB
    $self.protocolsCoordinated = ($self.protocolsCoordinated || 0) + 1
  }

  coordinator --> workerA: Summary = {
    onSend {
      $ctx.msg.text = $ctx.summary
    }
  }
  coordinator --> workerB: Summary = {
    onSend {
      $ctx.msg.text = $ctx.summary
    }
  }
}

role CoordinatorRole [ts] {
  plays ParDemo as coordinator

  init {
    $self.protocolsCoordinated = 0
  }

  on protocolCompleted(ParDemo) {
    $self.lastCompletedAt = Date.now()
  }
}

role WorkerARole [ts] {
  plays ParDemo as workerA

  init {
    $self.tasksCompleted = 0
  }

  on protocolCompleted(ParDemo) {
    $self.lastCompletedAt = Date.now()
  }
}

role WorkerBRole [ts] {
  plays ParDemo as workerB

  init {
    $self.tasksCompleted = 0
  }

  on protocolCompleted(ParDemo) {
    $self.lastCompletedAt = Date.now()
  }
}

agent CoordinatorAgent runs CoordinatorRole
agent WorkerAAgent runs WorkerARole
agent WorkerBAgent runs WorkerBRole
