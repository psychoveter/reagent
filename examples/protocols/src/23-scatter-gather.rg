// Example 23: scatter/gather — dynamic multicast to a list of agents
//
// Demonstrates scatter: send a message to each agent in a dynamic list,
// collect responses, then proceed.
//
// The coordinator sends a Subtask to each worker in $ctx.workers (agent IDs for role `worker`),
// waits for all SubtaskDone responses, then merges results.

message Subtask {}
message SubtaskDone {}

protocol ScatterGather {
  participants:
    coordinator [ts] initiator,
    worker [ts]
  trigger on invoke with Start {
    resolve coordinator = single
    resolve worker = single
  }

  coordinator {
    $ctx.workers = $ctx.input.workerIds
    $ctx.results = []
  }

  scatter ($ctx.workers as worker) {
    coordinator --> worker: Subtask = {
      onSend {
        $ctx.msg.taskId = $ctx._scatterIdx
      }
    }
    worker {
      $ctx.result = "done:" + $ctx.msg.taskId
    }
    worker --> coordinator: SubtaskDone = {
      onSend {
        $ctx.msg.result = $ctx.result
      }
      onReceive {
        $ctx.results.push($ctx.msg.result)
      }
    }
  }

  coordinator {
    $ctx.merged = $ctx.results.join(",")
    $self.scattersCompleted = ($self.scattersCompleted || 0) + 1
  }
}

role CoordinatorRole [ts] {
  plays ScatterGather as coordinator

  init {
    $self.scattersCompleted = 0
  }
}

role WorkerRole [ts] {
  plays ScatterGather as worker
}

agent CoordinatorAgent runs CoordinatorRole
agent WorkerAgent runs WorkerRole
