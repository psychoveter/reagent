// Task Delegation — minimal two-party protocol for MCP Gate E2E demo.
//
// human  — initiator (Cursor IDE via MCP Gate)
// worker — executor (Claude Code via MCP Gate)
//
// Single round-trip: human sends a task description, worker processes it
// and returns a result summary.

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

  human --> worker: TaskRequest = {
    onSend {
      $ctx.msg.description = $ctx.input.description || "No description"
      $ctx.msg.context = $ctx.input.context || {}
    }
  }

  worker --> human: TaskResult = {
    onSend {
      $ctx.msg.result = $ctx.input.result || "processed"
      $ctx.msg.summary = $ctx.input.summary || "Task completed"
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
