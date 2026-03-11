// Task Delegation — minimal two-party protocol for MCP Gate E2E demo.
//
// human  — initiator (Cursor IDE via MCP Gate)
// worker — executor (Claude Code via MCP Gate)
//
// Single round-trip with real agent work on both ends:
// - human prepares a delegation brief
// - worker completes the task
// - human reviews and records the result

// ─── Messages ────────────────────────────────────────────────────────

message TaskRequest {
  description: string
  context: any
}

message TaskResult {
  result: any
  summary: string
}

// ─── Protocol ────────────────────────────────────────────────────────

protocol TaskDelegation {
  participants:
    human [ts] initiator,
    worker [ts]

  trigger on invoke with TaskRequest {
    resolve human = single
    resolve worker = single
  }

  human {
    // Prepare a worker-facing task packet from the trigger input.
    // Preserve the original input under $ctx.originalInput.
    // Set:
    // - $ctx.originalInput = $ctx.input
    // - $ctx.request.description = non-empty string from $ctx.input.description
    // - $ctx.request.context = object from $ctx.input.context (or {})
    // - $ctx.request.requestedBy = "HumanAgent"
    // - $ctx.request.successCriteria = short string explaining what a good answer should contain
  }

  human --> worker: TaskRequest = {
    onSend {
      // Copy the prepared delegation request into the outgoing message.
      // Set:
      // - $ctx.msg.description = $ctx.request.description
      // - $ctx.msg.context = $ctx.request.context
      // - $ctx.msg.requestedBy = $ctx.request.requestedBy
      // - $ctx.msg.successCriteria = $ctx.request.successCriteria
    }
    onReceive {
      // Store the inbound task request on the worker side.
      // Set $ctx.receivedTask = {
      //   description: $ctx.msg.description,
      //   context: $ctx.msg.context,
      //   requestedBy: $ctx.msg.requestedBy,
      //   successCriteria: $ctx.msg.successCriteria
      // }
    }
  }

  worker {
    // Complete the delegated task.
    // Read the task from $ctx.receivedTask.
    // Produce:
    // - $ctx.workResult = {
    //     deliverable: concise but useful answer to the task,
    //     rationale: short explanation of how you solved it
    //   }
    // - $ctx.workSummary = one short sentence summarizing the outcome
  }

  worker --> human: TaskResult = {
    onSend {
      // Send the finished work back to the human.
      // Set:
      // - $ctx.msg.result = $ctx.workResult
      // - $ctx.msg.summary = $ctx.workSummary
    }
    onReceive {
      // Review and persist the worker result on the human side.
      // Set:
      // - $ctx.review = {
      //     accepted: true,
      //     summary: $ctx.msg.summary,
      //     result: $ctx.msg.result
      //   }
      // - $self.lastCompletedTask = {
      //     description: $ctx.request.description,
      //     summary: $ctx.msg.summary,
      //     result: $ctx.msg.result
      //   }
    }
  }
}

// ─── Roles ───────────────────────────────────────────────────────────

role HumanRole [ts] {
  plays TaskDelegation as human
}

role WorkerRole [ts] {
  plays TaskDelegation as worker
}

// ─── Agents ──────────────────────────────────────────────────────────

agent HumanAgent runs HumanRole
agent WorkerAgent runs WorkerRole
