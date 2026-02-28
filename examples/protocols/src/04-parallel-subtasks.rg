message Subtask {}
message SubtaskDone {}

// Example 04: par (parallel branches) + join
// Intent: comma decomposes a task into two subtasks, runs them in parallel, then joins results.
// $ctx carries results between roles; $ctx.msg is per-branch isolated.

protocol ParallelSubtasks {
  participants:
    comma [ts] initiator,
    worker1 [ts],
    worker2 [ts]
  trigger on invoke with Start {
    resolve comma = single
    resolve worker1 = single
    resolve worker2 = single
  }

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

role CommaRole [ts] {
  plays ParallelSubtasks as comma
}

role Worker1Role [ts] {
  plays ParallelSubtasks as worker1
}

role Worker2Role [ts] {
  plays ParallelSubtasks as worker2
}

agent Comma runs CommaRole
agent Worker1 runs Worker1Role
agent Worker2 runs Worker2Role
