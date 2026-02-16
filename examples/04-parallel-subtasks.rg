// Example 04: par (parallel branches) + join
// Intent: comma decomposes a task into two subtasks, runs them in parallel, then joins results.
// Roles: comma, worker1, worker2
//
// Required acts: par, join, correlation, internal action to merge results.

protocol ParallelSubtasks {
  participants: comma, worker1, worker2
  initiator: comma
  input: Start

  comma --> worker1: Subtask = { onSend: { call: "comma.emitSubtask", args: { id: "a" } } }
  comma --> worker2: Subtask = { onSend: { call: "comma.emitSubtask", args: { id: "b" } } }

  par {
    worker1 --> comma: SubtaskDone = { onReceive: { call: "comma.onSubtaskDone", args: { id: "a" } } }
  } and {
    worker2 --> comma: SubtaskDone = { onReceive: { call: "comma.onSubtaskDone", args: { id: "b" } } }
  }

  comma {
    // join/merge results
    ctx.result = merge(ctx.subtask.a, ctx.subtask.b)
  }
}

