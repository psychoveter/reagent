// Example 23: scatter/gather — dynamic multicast to a list of agents
//
// Demonstrates scatter: send a message to each agent in a dynamic list,
// collect responses, then proceed.
//
// The coordinator sends a Subtask to each worker in $flow.workers (agent IDs for role `worker`),
// waits for all SubtaskDone responses, then merges results.

message Subtask {}
message SubtaskDone {}

protocol ScatterGather {
  participants: coordinator [ts], worker [ts]
  initiator: coordinator
  input: Start

  coordinator {
    $flow.workers = $ctx.input.workerIds
    $flow.results = []
  }

  scatter ($flow.workers as worker) {
    coordinator --> worker: Subtask = {
      onSend {
        $ctx.msg.taskId = $flow.workers.indexOf(worker)
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
        $flow.results.push($ctx.msg.result)
      }
    }
  }

  coordinator {
    $flow.merged = $flow.results.join(",")
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
