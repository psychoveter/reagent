// Example 10: protocol start by external input (unknown sender) + emitting events
//
// Requirement:
// - protocol can start on an external input message (unknown sender)
// - events can be emitted outward (reserved statement `emit`)

protocol TaskExecutionFromEvent {
  participants: comma, sia
  initiator: comma
  input: TaskRequested

  comma {
    ctx.taskText = $input.text
  }

  comma --> sia: SubmitIntent = { }

  // Emit event outward for tracing/observability/other agents.
  emit TaskSubmitted = { kind: "task.submitted", ref: "$ctx.intent" }
}

