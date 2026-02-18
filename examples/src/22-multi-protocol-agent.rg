// Example 22: Self-contained multi-protocol agent (M5-CTRL test)
//
// WorkerAgent plays roles in two different protocols concurrently:
//   - TaskProcessing: receives a task, processes it, returns result
//   - HealthCheck: receives a ping, responds with health status
//
// Verifies: messages for each protocol reach the correct ProtocolInstance
// inside the same AgentRunner; $self state is shared across both;
// lifecycle handlers fire for each.

message TaskRequest {}
message TaskResult {}
message Ping {}
message Pong {}

protocol TaskProcessing {
  participants: client [ts], worker [ts]
  initiator: client

  client --> worker: TaskRequest = {
    onSend { $ctx.msg.taskId = 42 }
    onReceive {
      $ctx.taskId = $ctx.msg.taskId
    }
  }
  worker {
    $self.tasksProcessed = ($self.tasksProcessed || 0) + 1
    $ctx.result = "done:" + $ctx.taskId
  }
  worker --> client: TaskResult = {
    onSend { $ctx.msg.result = $ctx.result }
    onReceive {
      $self.lastResult = $ctx.msg.result
    }
  }
}

protocol HealthCheck {
  participants: monitor [ts], worker [ts]
  initiator: monitor

  monitor --> worker: Ping = {
    onSend { $ctx.msg.ts = Date.now() }
    onReceive {
      $self.healthChecks = ($self.healthChecks || 0) + 1
    }
  }
  worker --> monitor: Pong = {
    onSend {
      $ctx.msg.status = "ok"
      $ctx.msg.tasksProcessed = $self.tasksProcessed || 0
    }
    onReceive {
      $self.lastPong = $ctx.msg
    }
  }
}

role ClientRole [ts] {
  plays TaskProcessing as client

  init { $self.requestsSent = 0 }

  on protocolCompleted(TaskProcessing) {
    $self.requestsSent = ($self.requestsSent || 0) + 1
  }
}

role MonitorRole [ts] {
  plays HealthCheck as monitor

  init { $self.pongCount = 0 }

  on protocolCompleted(HealthCheck) {
    $self.pongCount = ($self.pongCount || 0) + 1
  }
}

role WorkerRole [ts] {
  plays TaskProcessing as worker
  plays HealthCheck as worker

  init {
    $self.tasksProcessed = 0
    $self.healthChecks = 0
  }

  on protocolCompleted(TaskProcessing) {
    $self.taskCompletions = ($self.taskCompletions || 0) + 1
  }

  on protocolCompleted(HealthCheck) {
    $self.healthCompletions = ($self.healthCompletions || 0) + 1
  }
}

agent ClientAgent runs ClientRole
agent MonitorAgent runs MonitorRole
agent WorkerAgent runs WorkerRole
