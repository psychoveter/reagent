export function createDefaultRuntimeConfig(nodeId) {
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
