// Example 21: role inheritance via `extends`
// Data flows between roles via $ctx.msg (onSend/onReceive). $ctx is per-role.

message Ping {}
message Pong {}
message Task {}
message TaskDone {}

protocol HealthCheck {
  participants: monitor [*], node [ts]
  initiator: monitor
  input: Ping

  monitor --> node: Ping = { }
  node --> monitor: Pong = {
    onSend {
      $ctx.msg.healthy = $self.healthy
      $ctx.msg.uptime = $self.uptime
    }
  }
}

protocol TaskProcessing {
  participants: dispatcher [ts], worker [ts]
  initiator: dispatcher
  input: Task

  dispatcher --> worker: Task = {
    onSend {
      $ctx.msg.payload = $ctx.input.payload
    }
    onReceive {
      $ctx.payload = $ctx.msg.payload
    }
  }

  worker {
    $ctx.result = "processed:" + $ctx.payload
    $self.tasksCompleted = ($self.tasksCompleted || 0) + 1
  }

  worker --> dispatcher: TaskDone = {
    onSend {
      $ctx.msg.result = $ctx.result
    }
    onReceive {
      $self.lastResult = $ctx.msg.result
    }
  }
}

role BaseMonitored [ts] {
  plays HealthCheck as node

  init {
    $self.healthy = true
    $self.uptime = 0
  }

  on protocolFailed(HealthCheck) {
    $self.healthy = false
  }
}

role WorkerRole [ts] extends BaseMonitored {
  plays TaskProcessing as worker

  init {
    $self.tasksCompleted = 0
  }

  on protocolCompleted(TaskProcessing) {
    $self.uptime = $self.uptime + 1
  }
}

role DispatcherRole [ts] {
  plays TaskProcessing as dispatcher

  init {
    $self.lastResult = ""
  }
}

agent Worker runs WorkerRole
agent Dispatcher runs DispatcherRole
