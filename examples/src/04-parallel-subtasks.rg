message Subtask {}
message SubtaskDone {}

// Example 04: par (parallel branches) + join
// Intent: comma decomposes a task into two subtasks, runs them in parallel, then joins results.
// Roles: comma [ts], worker1 [ts], worker2 [ts]
//
// Required acts: par, join, correlation, internal action to merge results.

protocol ParallelSubtasks {
  participants: comma [ts], worker1 [ts], worker2 [ts]
  initiator: comma
  input: Start

  comma --> worker1: Subtask = {
    onSend {
      $ctx.msg.id = "a"
    }
  }
  comma --> worker2: Subtask = {
    onSend {
      $ctx.msg.id = "b"
    }
  }

  par {
    worker1 --> comma: SubtaskDone = {
      onReceive {
        $ctx.subtaskA = $ctx.msg
      }
    }
  } and {
    worker2 --> comma: SubtaskDone = {
      onReceive {
        $ctx.subtaskB = $ctx.msg
      }
    }
  }

  comma {
    $ctx.result = merge($ctx.subtaskA, $ctx.subtaskB)
  }
}
