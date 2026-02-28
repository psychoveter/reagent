/**
 * TriggerPolicy — runtime configuration for trigger behavior.
 *
 * Configured at deployment time (deployment.json or runtime API), not in .rg syntax.
 * Enforced by TriggerMatcher before instantiation.
 */

export interface TriggerPolicy {
  enabled: boolean;
  maxConcurrent?: number;
  cooldownMs?: number;
  circuitBreaker?: {
    failureThreshold: number;
    resetMs: number;
  };
  dedup?: {
    windowMs: number;
  };
}

export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = { enabled: true };

export type CircuitState = "closed" | "open" | "half-open";

export interface TriggerPolicyState {
  runningCount: number;
  lastFiredAt: number;
  circuit: CircuitState;
  consecutiveFailures: number;
  circuitOpenedAt: number;
  recentPayloadHashes: Array<{ hash: string; ts: number }>;
}

export function createPolicyState(): TriggerPolicyState {
  return {
    runningCount: 0,
    lastFiredAt: 0,
    circuit: "closed",
    consecutiveFailures: 0,
    circuitOpenedAt: 0,
    recentPayloadHashes: [],
  };
}

export type SuppressionReason =
  | "disabled"
  | "max_concurrent"
  | "cooldown"
  | "circuit_open"
  | "dedup";

/**
 * Evaluate policy: returns null if allowed, or SuppressionReason if suppressed.
 */
export function evaluatePolicy(
  policy: TriggerPolicy,
  state: TriggerPolicyState,
  payloadHash: string,
  now: number,
): SuppressionReason | null {
  if (!policy.enabled) return "disabled";

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
      } else {
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

export function recordTriggerFired(state: TriggerPolicyState, payloadHash: string, now: number): void {
  state.runningCount++;
  state.lastFiredAt = now;
  state.recentPayloadHashes.push({ hash: payloadHash, ts: now });
}

export function recordTriggerCompleted(state: TriggerPolicyState, success: boolean, policy: TriggerPolicy): void {
  state.runningCount = Math.max(0, state.runningCount - 1);
  if (success) {
    state.consecutiveFailures = 0;
    if (state.circuit === "half-open") state.circuit = "closed";
  } else {
    state.consecutiveFailures++;
    if (
      policy.circuitBreaker &&
      state.consecutiveFailures >= policy.circuitBreaker.failureThreshold
    ) {
      state.circuit = "open";
      state.circuitOpenedAt = Date.now();
    }
  }
}
