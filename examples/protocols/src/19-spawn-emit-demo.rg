// Example 19: async invokes (fire-and-forget protocol call) + reagent.emit (event broadcasting)
// Uses protocol-level `async invokes` for non-blocking sub-protocol launch.

message WorkRequest {}
message WorkResult {}

protocol BackgroundTask {
  participants:
    worker [ts] initiator
  trigger on invoke with TaskInput {
    resolve worker = single
  }

  worker {
    $ctx.result = "bg-done:" + $ctx.input.taskName
    $self.bgTasksCompleted = ($self.bgTasksCompleted || 0) + 1
  }
}

protocol SpawnEmitDemo {
  participants:
    orchestrator [ts] initiator,
    helper [ts]

  orchestrator {
    $ctx.taskName = "compute"
  }

  orchestrator async invokes BackgroundTask({ taskName: $ctx.taskName })

  orchestrator {
    $self.spawned = ($self.spawned || 0) + 1
  }

  orchestrator --> helper: WorkRequest = {
    onSend {
      $ctx.msg.task = $ctx.taskName
    }
    onReceive {
      $ctx.task = $ctx.msg.task
    }
  }

  helper {
    $ctx.result = "done:" + $ctx.task
    reagent.emit("TaskProcessed", { task: $ctx.task })
  }

  helper --> orchestrator: WorkResult = {
    onSend {
      $ctx.msg.result = $ctx.result
    }
    onReceive {
      $self.lastResult = $ctx.msg.result
    }
  }
}

role OrchestratorRole [ts] {
  plays SpawnEmitDemo as orchestrator
  plays BackgroundTask as worker

  init {
    $self.spawned = 0
    $self.bgTasksCompleted = 0
    $self.lastResult = ""
  }
}

role HelperRole [ts] {
  plays SpawnEmitDemo as helper

  init {
    $self.eventsHandled = 0
  }

  on protocolEvent(TaskProcessed) {
    $self.eventsHandled = ($self.eventsHandled || 0) + 1
  }
}

agent OrchestratorAgent runs OrchestratorRole
agent HelperAgent runs HelperRole
