/**
 * OTel message-level interceptor for ReagentController.
 *
 * Maps each message to an OpenTelemetry span nested under a per-protocol-instance
 * trace. Requires `@opentelemetry/api` at runtime.
 */

import { type Span, type Tracer, SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { InterceptorFn, InterceptorContext } from "../contracts/interceptor.js";

const TRACER_NAME = "reagent.messages";

const instanceSpans = new Map<string, Span>();

function getOrCreateInstanceSpan(tracer: Tracer, instanceId: string, protocolName: string): Span {
  let root = instanceSpans.get(instanceId);
  if (!root) {
    root = tracer.startSpan(`protocol:${protocolName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "reagent.instance_id": instanceId,
        "reagent.protocol": protocolName,
      },
    });
    instanceSpans.set(instanceId, root);
  }
  return root;
}

export function endInstanceSpan(instanceId: string, error?: string): void {
  const span = instanceSpans.get(instanceId);
  if (!span) return;
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
  }
  span.end();
  instanceSpans.delete(instanceId);
}

export function createOTelInterceptor(tracer?: Tracer): InterceptorFn {
  const t = tracer ?? trace.getTracer(TRACER_NAME);

  return (ctx: InterceptorContext, next: () => void) => {
    const env = ctx.envelope;
    const parentSpan = getOrCreateInstanceSpan(t, env.instanceId, env.protocolName);
    const parentCtx = trace.setSpan(context.active(), parentSpan);

    const span = t.startSpan(
      `${ctx.direction}:${env.messageName}`,
      {
        kind: ctx.direction === "inbound" ? SpanKind.SERVER : SpanKind.CLIENT,
        attributes: {
          "reagent.instance_id": env.instanceId,
          "reagent.protocol": env.protocolName,
          "reagent.message": env.messageName,
          "reagent.direction": ctx.direction,
          "reagent.from.agent": env.from.agent,
          "reagent.from.role": env.from.role,
          "reagent.to.agent": env.to.agent,
          "reagent.to.role": env.to.role,
          "reagent.node_id": ctx.nodeId,
        },
      },
      parentCtx,
    );

    try {
      next();
    } finally {
      span.end();
    }
  };
}
