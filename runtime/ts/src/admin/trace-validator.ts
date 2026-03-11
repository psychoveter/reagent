/**
 * Trace Validator — checks that a collected trace is legal with respect to an IRGraph.
 *
 * Given a role's IR graph and its trace events, the validator walks the state machine
 * and verifies that:
 * 1. Messages are sent/received in the order dictated by the IR
 * 2. All expected messages are present (completeness)
 * 3. The protocol completed correctly
 */

import type { IRGraph, IRState, IRTransition } from "../contracts/types.js";
import type { TraceEvent } from "../contracts/types.js";

export type ValidationDiagnostic = {
  level: "error" | "warning";
  message: string;
  traceIndex?: number;
  stateId?: string;
};

export type ValidationResult = {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
};

export function validateTrace(graph: IRGraph, traces: TraceEvent[]): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  const stateMap = new Map<string, IRState>();
  for (const s of graph.states) {
    stateMap.set(s.id, s);
  }

  const transitionsFrom = new Map<string, IRTransition[]>();
  for (const t of graph.transitions) {
    transitionsFrom.set(t.from, [...(transitionsFrom.get(t.from) ?? []), t]);
  }

  const msgSent = traces
    .filter(t => t.kind === "MessageSent")
    .map(t => t.data?.messageName as string);

  const msgRecv = traces
    .filter(t => t.kind === "MessageReceived")
    .map(t => t.data?.messageName as string);

  const expectedSends: string[] = [];
  const expectedReceives: string[] = [];

  let currentId = graph.initialStateId;
  const visited = new Set<string>();
  const maxSteps = graph.states.length * 3;
  let steps = 0;

  while (steps++ < maxSteps) {
    if (visited.has(currentId) && steps > 2) break;
    visited.add(currentId);

    const state = stateMap.get(currentId);
    if (!state) {
      diagnostics.push({
        level: "error",
        message: `IR state ${currentId} not found in graph`,
        stateId: currentId,
      });
      break;
    }

    if (state.data.kind === "send") {
      expectedSends.push((state.data as { messageName: string }).messageName);
    } else if (state.data.kind === "receive") {
      expectedReceives.push((state.data as { messageName: string }).messageName);
    } else if (state.data.kind === "terminal") {
      break;
    }

    const trans = transitionsFrom.get(currentId) ?? [];
    const def = trans.find(t => t.label.kind === "default");
    if (def) {
      currentId = def.to;
    } else if (trans.length > 0) {
      currentId = trans[0].to;
    } else {
      break;
    }
  }

  let sendIdx = 0;
  for (const sent of msgSent) {
    if (sendIdx < expectedSends.length && expectedSends[sendIdx] === sent) {
      sendIdx++;
    } else {
      const found = expectedSends.indexOf(sent, sendIdx);
      if (found === -1) {
        diagnostics.push({
          level: "error",
          message: `Unexpected sent message "${sent}" — not in expected IR sequence`,
        });
      } else {
        for (let i = sendIdx; i < found; i++) {
          diagnostics.push({
            level: "warning",
            message: `Expected sent message "${expectedSends[i]}" was skipped`,
          });
        }
        sendIdx = found + 1;
      }
    }
  }

  let recvIdx = 0;
  for (const recv of msgRecv) {
    if (recvIdx < expectedReceives.length && expectedReceives[recvIdx] === recv) {
      recvIdx++;
    } else {
      const found = expectedReceives.indexOf(recv, recvIdx);
      if (found === -1) {
        diagnostics.push({
          level: "error",
          message: `Unexpected received message "${recv}" — not in expected IR sequence`,
        });
      } else {
        for (let i = recvIdx; i < found; i++) {
          diagnostics.push({
            level: "warning",
            message: `Expected received message "${expectedReceives[i]}" was skipped`,
          });
        }
        recvIdx = found + 1;
      }
    }
  }

  const hasCompleted = traces.some(t => t.kind === "ProtocolCompleted");
  const hasFailed = traces.some(t => t.kind === "ProtocolFailed");

  if (!hasCompleted && !hasFailed) {
    diagnostics.push({
      level: "error",
      message: "Protocol trace has no completion event (ProtocolCompleted or ProtocolFailed)",
    });
  }

  if (hasCompleted) {
    for (let i = sendIdx; i < expectedSends.length; i++) {
      diagnostics.push({
        level: "warning",
        message: `Expected sent message "${expectedSends[i]}" was not found in trace`,
      });
    }
    for (let i = recvIdx; i < expectedReceives.length; i++) {
      diagnostics.push({
        level: "warning",
        message: `Expected received message "${expectedReceives[i]}" was not found in trace`,
      });
    }
  }

  const hasStarted = traces.some(t => t.kind === "ProtocolStarted");
  if (!hasStarted) {
    diagnostics.push({
      level: "error",
      message: "Protocol trace missing ProtocolStarted event",
    });
  }

  return {
    valid: diagnostics.filter(d => d.level === "error").length === 0,
    diagnostics,
  };
}

export function isMessageLegal(
  graph: IRGraph,
  existingTrace: TraceEvent[],
  messageName: string,
  direction: "sent" | "received",
): boolean {
  const result = validateTrace(graph, [
    ...existingTrace,
    {
      instanceId: "",
      eventId: "",
      kind: direction === "sent" ? "MessageSent" : "MessageReceived",
      ts: Date.now(),
      agent: "",
      data: { messageName },
    } as unknown as TraceEvent,
  ]);

  return result.diagnostics.filter(
    d => d.level === "error"
      && d.message.includes(`Unexpected ${direction === "sent" ? "sent" : "received"} message "${messageName}"`),
  ).length === 0;
}
