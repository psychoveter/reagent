// Example 19: reagent.spawn (fire-and-forget) + reagent.emit (event broadcasting)
//
// Tests:
//   T15: Spawn starts child instance, parent continues without waiting
//   T16: Emit triggers agent lifecycle handler (protocolEvent)

message WorkRequest {}
message WorkResult {}

protocol BackgroundTask {
  participants: worker [ts]
  initiator: worker
  input: TaskInput

  worker {
    $ctx.result = "bg-done:" + $ctx.input.taskName
    $self.bgTasksCompleted = ($self.bgTasksCompleted || 0) + 1
  }
}

protocol SpawnEmitDemo {
  participants: orchestrator [ts], helper [ts]
  initiator: orchestrator

  orchestrator {
    $ctx.taskName = "compute"
    reagent.spawn("BackgroundTask", { taskName: $ctx.taskName })
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
