/**
 * Zone Executor — runs raw host-language (TypeScript/JS) zone bodies
 * with $ctx, $self, and reagent injected into scope.
 *
 * The injected `reagent` object exposes only the stable v0 surface documented
 * in `docs/current/02-lang-spec.md` §1.4: `return`, `emit`, and `break`.
 * Child protocol invocation and role spawning are protocol-level constructs
 * (`<role> invokes`, `<role> async invokes`, `<role> spawns`), not zone-level
 * `reagent.*` calls.
 */

export type ReagentStub = {
  emit: (eventName: string, data?: Record<string, unknown>) => void;
  return: (value: unknown) => void;
  break: () => void;
};

export function createReagentStub(): ReagentStub {
  return {
    emit: (eventName, data) => {
      throw new EmitRequest(eventName, data);
    },
    return: (value) => {
      throw new ReturnValue(value);
    },
    break: () => {
      throw new BreakRequest();
    },
  };
}

/** Sentinel thrown when a zone calls reagent.return() */
export class ReturnValue {
  readonly __reagentReturn = true;
  constructor(public readonly value: unknown) {}
}

/** Sentinel thrown when a zone calls reagent.emit() */
export class EmitRequest {
  readonly __reagentEmit = true;
  constructor(
    public readonly eventName: string,
    public readonly data?: Record<string, unknown>,
  ) {}
}

/** Sentinel thrown when a zone calls reagent.break() */
export class BreakRequest {
  readonly __reagentBreak = true;
}

/**
 * Execute a zone body string with $ctx, $self, reagent, and optional extras in scope.
 */
export function executeZone(
  body: string,
  ctx: Record<string, unknown>,
  self: Record<string, unknown>,
  reagent: ReagentStub,
  extras?: Record<string, unknown>,
): boolean {
  const paramNames = ["$ctx", "$self", "reagent"];
  const paramValues: unknown[] = [ctx, self, reagent];

  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      paramNames.push(k);
      paramValues.push(v);
    }
  }

  const fn = new Function(...paramNames, body);
  fn(...paramValues);
  return true;
}

/**
 * Async zone executor — for zone bodies that contain `await`.
 * Uses AsyncFunction constructor to support top-level await in zone scope.
 */
export async function executeZoneAsync(
  body: string,
  ctx: Record<string, unknown>,
  self: Record<string, unknown>,
  reagent: ReagentStub,
  extras?: Record<string, unknown>,
): Promise<boolean> {
  const paramNames = ["$ctx", "$self", "reagent"];
  const paramValues: unknown[] = [ctx, self, reagent];

  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      paramNames.push(k);
      paramValues.push(v);
    }
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(...paramNames, body);
  await fn(...paramValues);
  return true;
}

export class ZoneError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ZoneError";
  }
}
