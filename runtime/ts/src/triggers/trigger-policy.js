/**
 * TriggerPolicy — runtime configuration for trigger behavior.
 *
 * Configured at deployment time (deployment.json or runtime API), not in .rg syntax.
 * Enforced by TriggerMatcher before instantiation.
 */
export const DEFAULT_TRIGGER_POLICY = { enabled: true };
export function createPolicyState() {
    return {
        runningCount: 0,
        lastFiredAt: 0,
        circuit: "closed",
        consecutiveFailures: 0,
        circuitOpenedAt: 0,
        recentPayloadHashes: [],
    };
}
/**
 * Evaluate policy: returns null if allowed, or SuppressionReason if suppressed.
 */
export function evaluatePolicy(policy, state, payloadHash, now) {
    if (!policy.enabled)
        return "disabled";
    if (policy.maxConcurrent != null && state.runningCount >= policy.maxConcurrent) {
        return "max_concurrent";
    }
    if (policy.cooldownMs != null && now - state.lastFiredAt < policy.cooldownMs) {
        return "cooldown";
    }
    if (policy.circuitBreaker) {
        if (state.circuit === "open") {
            if (now - state.circuitOpenedAt >= policy.circuitBreaker.resetMs) {
                state.circuit = "half-open";
            }
            else {
                return "circuit_open";
            }
        }
    }
    if (policy.dedup) {
        const cutoff = now - policy.dedup.windowMs;
        state.recentPayloadHashes = state.recentPayloadHashes.filter(e => e.ts >= cutoff);
        if (state.recentPayloadHashes.some(e => e.hash === payloadHash)) {
            return "dedup";
        }
    }
    return null;
}
export function recordTriggerFired(state, payloadHash, now) {
    state.runningCount++;
    state.lastFiredAt = now;
    state.recentPayloadHashes.push({ hash: payloadHash, ts: now });
}
export function recordTriggerCompleted(state, success, policy) {
    state.runningCount = Math.max(0, state.runningCount - 1);
    if (success) {
        state.consecutiveFailures = 0;
        if (state.circuit === "half-open")
            state.circuit = "closed";
    }
    else {
        state.consecutiveFailures++;
        if (policy.circuitBreaker &&
            state.consecutiveFailures >= policy.circuitBreaker.failureThreshold) {
            state.circuit = "open";
            state.circuitOpenedAt = Date.now();
        }
    }
}
