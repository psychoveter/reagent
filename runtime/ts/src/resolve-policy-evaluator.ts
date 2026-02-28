/**
 * ResolvePolicyEvaluator — evaluates resolve pipelines against the agent registry.
 *
 * Given a ResolvePolicyIR pipeline and a role name, produces a list of matched
 * AgentRegistration entries through source → filter → selection stages.
 */

import type { ResolvePolicyIR, ResolvePipelineStepIR, TraceEvent } from "./types.js";
import { createTraceEvent } from "./types.js";
import type { AgentRegistration, AgentRegistry } from "./state-store-agent-registry.js";
import type { TraceHook } from "./interceptor.js";

export type ResolveContext = {
  triggerId?: string;
  instanceId?: string;
  input?: Record<string, unknown>;
};

export type CustomResolvePolicy = (
  candidates: AgentRegistration[],
  ctx: ResolveContext,
) => AgentRegistration[];

export type DebugResolveHook = (data: {
  role: string;
  candidates: string[];
  selected: string[];
  pipeline: string[];
}) => Promise<void>;

export class ResolvePolicyEvaluator {
  private registry: AgentRegistry;
  private customPolicies = new Map<string, CustomResolvePolicy>();
  private roundRobinCursors = new Map<string, number>();
  private traceHook?: TraceHook;
  private debugHook?: DebugResolveHook;

  constructor(registry: AgentRegistry, traceHook?: TraceHook) {
    this.registry = registry;
    this.traceHook = traceHook;
  }

  setTraceHook(hook: TraceHook): void {
    this.traceHook = hook;
  }

  setDebugHook(hook: DebugResolveHook | undefined): void {
    this.debugHook = hook;
  }

  registerCustomPolicy(name: string, impl: CustomResolvePolicy): void {
    this.customPolicies.set(name, impl);
  }

  async evaluate(
    pipeline: ResolvePolicyIR,
    role: string,
    ctx: ResolveContext = {},
    triggerId?: string,
  ): Promise<AgentRegistration[]> {
    const initialCandidates = this.registry.findByRole(role);
    let candidates = initialCandidates;

    for (const step of pipeline) {
      candidates = this.applyStep(step, candidates, role, ctx, triggerId);
    }

    if (this.traceHook) {
      this.traceHook(createTraceEvent(
        ctx.instanceId ?? "",
        "ResolveCompleted",
        "",
        {
          role,
          data: {
            role,
            pipeline: pipeline.map(s => s.step),
            candidateCount: initialCandidates.length,
            selectedCount: candidates.length,
            selected: candidates.map(a => a.name),
          },
        },
      ));
    }

    if (this.debugHook) {
      await this.debugHook({
        role,
        candidates: initialCandidates.map(a => a.name),
        selected: candidates.map(a => a.name),
        pipeline: pipeline.map(s => s.step),
      });
    }

    return candidates;
  }

  private applyStep(
    step: ResolvePipelineStepIR,
    candidates: AgentRegistration[],
    role: string,
    ctx: ResolveContext,
    triggerId?: string,
  ): AgentRegistration[] {
    switch (step.step) {
      case "all":
        return this.registry.findByRole(role);

      case "single": {
        const byRole = this.registry.findByRole(role);
        return byRole.length > 0 ? [byRole[0]] : [];
      }

      case "from":
        return this.applyFrom(step.expr, ctx);

      case "filter":
        return candidates.filter(agent => this.evaluateFilter(step.predicate, agent));

      case "first":
        return candidates.length > 0 ? [candidates[0]] : [];

      case "random": {
        if (candidates.length === 0) return [];
        const idx = Math.floor(Math.random() * candidates.length);
        return [candidates[idx]];
      }

      case "sample": {
        if (candidates.length === 0) return [];
        const shuffled = [...candidates].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, Math.min(step.count, shuffled.length));
      }

      case "roundRobin": {
        if (candidates.length === 0) return [];
        const key = `rr:${role}:${triggerId ?? "default"}`;
        const cursor = (this.roundRobinCursors.get(key) ?? 0) % candidates.length;
        this.roundRobinCursors.set(key, cursor + 1);
        return [candidates[cursor]];
      }

      case "leastLoaded":
        // For now, treat as first — real implementation needs instance tracking
        return candidates.length > 0 ? [candidates[0]] : [];

      case "fallback": {
        if (candidates.length > 0) return candidates;
        let fallbackResult = this.registry.findByRole(role);
        for (const fbStep of step.chain) {
          fallbackResult = this.applyStep(fbStep, fallbackResult, role, ctx, triggerId);
        }
        return fallbackResult;
      }

      case "custom": {
        const impl = this.customPolicies.get(step.name);
        if (!impl) return candidates;
        return impl(candidates, ctx);
      }
    }
  }

  private applyFrom(expr: string, ctx: ResolveContext): AgentRegistration[] {
    // Evaluate `$ctx.input.*` references
    if (expr.startsWith("$ctx.input.")) {
      const path = expr.slice("$ctx.input.".length);
      const value = getNestedValue(ctx.input, path);
      if (typeof value === "string") {
        const agent = this.registry.get(value);
        return agent ? [agent] : [];
      }
      if (Array.isArray(value)) {
        return value
          .map(v => typeof v === "string" ? this.registry.get(v) : undefined)
          .filter((a): a is AgentRegistration => a != null);
      }
    }
    return [];
  }

  evaluateFilter(predicate: string, agent: AgentRegistration): boolean {
    try {
      return evaluateFilterExpr(predicate, agent);
    } catch {
      return false;
    }
  }

  resetRoundRobin(role?: string): void {
    if (role) {
      for (const key of this.roundRobinCursors.keys()) {
        if (key.startsWith(`rr:${role}:`)) this.roundRobinCursors.delete(key);
      }
    } else {
      this.roundRobinCursors.clear();
    }
  }
}

function getNestedValue(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a filter expression against an agent's metadata.
 *
 * Supported operations:
 * - `"value" in agent.tags` / `"value" in agent.capabilities`
 * - `agent.labels.key == "value"` / `agent.metadata.key == value`
 * - `agent.name == "value"`
 * - `&&`, `||`, `!`
 * - Comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`
 * - `agent.metadata._alive == true`
 */
function evaluateFilterExpr(expr: string, agent: AgentRegistration): boolean {
  const trimmed = expr.trim();

  // Handle || (lowest precedence)
  const orParts = splitTopLevel(trimmed, "||");
  if (orParts.length > 1) {
    return orParts.some(p => evaluateFilterExpr(p, agent));
  }

  // Handle &&
  const andParts = splitTopLevel(trimmed, "&&");
  if (andParts.length > 1) {
    return andParts.every(p => evaluateFilterExpr(p, agent));
  }

  // Handle !
  if (trimmed.startsWith("!")) {
    return !evaluateFilterExpr(trimmed.slice(1), agent);
  }

  // Handle parentheses
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return evaluateFilterExpr(trimmed.slice(1, -1), agent);
  }

  // `"value" in agent.tags` / `"value" in agent.capabilities`
  const inMatch = trimmed.match(/^"([^"]*?)"\s+in\s+agent\.(tags|capabilities)$/);
  if (inMatch) {
    const [, value, field] = inMatch;
    if (field === "tags") return agent.tags.includes(value);
    if (field === "capabilities") return agent.capabilities.includes(value);
    return false;
  }

  // `agent.labels.key == "value"`
  const labelMatch = trimmed.match(/^agent\.labels\.(\w+)\s*(==|!=)\s*"([^"]*)"$/);
  if (labelMatch) {
    const [, key, op, val] = labelMatch;
    const actual = agent.labels[key] ?? "";
    return op === "==" ? actual === val : actual !== val;
  }

  // `agent.metadata.key <op> value`
  const metaMatch = trimmed.match(/^agent\.metadata\.(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)$/);
  if (metaMatch) {
    const [, key, op, rawVal] = metaMatch;
    const actual = agent.metadata[key];
    const expected = parseValue(rawVal.trim());
    return compareValues(actual, op, expected);
  }

  // `agent.name == "value"`
  const nameMatch = trimmed.match(/^agent\.name\s*(==|!=)\s*"([^"]*)"$/);
  if (nameMatch) {
    const [, op, val] = nameMatch;
    return op === "==" ? agent.name === val : agent.name !== val;
  }

  return false;
}

function splitTopLevel(expr: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inStr = false;
  let strChar = "";

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];

    if (inStr) {
      current += ch;
      if (ch === strChar) inStr = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      current += ch;
      continue;
    }

    if (ch === "(") depth++;
    if (ch === ")") depth--;

    if (depth === 0 && expr.startsWith(delimiter, i)) {
      parts.push(current.trim());
      current = "";
      i += delimiter.length - 1;
      continue;
    }

    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  const n = Number(raw);
  if (!isNaN(n)) return n;
  return raw;
}

function compareValues(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">":  return (actual as number) > (expected as number);
    case "<":  return (actual as number) < (expected as number);
    case ">=": return (actual as number) >= (expected as number);
    case "<=": return (actual as number) <= (expected as number);
    default:   return false;
  }
}
