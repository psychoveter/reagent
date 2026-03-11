import type { TriggerPolicy } from "../triggers/trigger-policy.js";

export type StateStoreRuntimeConfig =
  | { kind: "memory" }
  | { kind: "etcd"; hosts: string[] };

export type MembershipRuntimeConfig = {
  enabled: boolean;
  leaseTtlSeconds?: number;
};

export type MessagePlaneRuntimeConfig =
  | { kind: "none" }
  | { kind: "nats"; url: string };

export type TelemetryRuntimeConfig = {
  traceSink?: "none" | "callback";
  interceptors?: string[];
};

export type ControlEndpointRuntimeConfig = {
  enabled?: boolean;
  host?: string;
  port?: number;
  advertiseUrl?: string;
};

export interface RuntimeConfig {
  nodeId: string;
  langs?: string[];
  stateStore: StateStoreRuntimeConfig;
  membership?: MembershipRuntimeConfig;
  messagePlane?: MessagePlaneRuntimeConfig;
  telemetry?: TelemetryRuntimeConfig;
  controlEndpoint?: ControlEndpointRuntimeConfig;
  triggerPolicies?: Record<string, TriggerPolicy>;
  cronIntervalMs?: number;
}

export function createDefaultRuntimeConfig(nodeId: string): RuntimeConfig {
  return {
    nodeId,
    langs: ["ts"],
    stateStore: { kind: "memory" },
    membership: { enabled: false },
    messagePlane: { kind: "none" },
    telemetry: { traceSink: "none", interceptors: [] },
    controlEndpoint: { enabled: false, host: "127.0.0.1", port: 0 },
    triggerPolicies: {},
    cronIntervalMs: 15_000,
  };
}
