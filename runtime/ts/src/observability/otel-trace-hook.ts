/**
 * OTel trace hook for agent-level events (TraceEvent).
 *
 * Configured per ProtocolInstance via the `traceHook` callback.
 * Creates a child span for every TraceEvent under the protocol instance trace.
 */

import { type Tracer, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { TraceHook } from "../contracts/interceptor.js";
import type { TraceEvent } from "../contracts/types.js";
import { endInstanceSpan } from "./otel-interceptor.js";

const TRACER_NAME = "reagent.traces";

export function createOTelTraceHook(tracer?: Tracer): TraceHook {
  const t = tracer ?? trace.getTracer(TRACER_NAME);

  return (event: TraceEvent) => {
    const span = t.startSpan(`trace:${event.kind}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "reagent.instance_id": event.instanceId,
        "reagent.event_id": event.eventId,
        "reagent.kind": event.kind,
        "reagent.agent": event.agent,
        ...(event.role && { "reagent.role": event.role }),
        ...(event.protocolName && { "reagent.protocol": event.protocolName }),
        ...(event.cause && { "reagent.cause": event.cause }),
      },
    });

    if (event.data) {
      for (const [key, value] of Object.entries(event.data)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          span.setAttribute(`reagent.data.${key}`, value);
        }
      }
    }

    if (event.kind === "ProtocolFailed") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.data?.error as string });
      endInstanceSpan(event.instanceId, event.data?.error as string);
    } else if (event.kind === "ProtocolCompleted") {
      endInstanceSpan(event.instanceId);
    }

    span.end();
  };
}
