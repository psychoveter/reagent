export interface NodeControlRequest {
  kind: "request";
  id: string;
  op: string;
  payload?: Record<string, unknown>;
}

export interface NodeControlSuccessResponse {
  kind: "response";
  id: string;
  ok: true;
  payload: Record<string, unknown>;
}

export interface NodeControlErrorResponse {
  kind: "response";
  id: string;
  ok: false;
  error: string;
}

export interface NodeControlEvent {
  kind: "event";
  event: string;
  payload: Record<string, unknown>;
}

export type NodeControlMessage =
  | NodeControlRequest
  | NodeControlSuccessResponse
  | NodeControlErrorResponse
  | NodeControlEvent;

export type NodeControlHandler = (
  op: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;
