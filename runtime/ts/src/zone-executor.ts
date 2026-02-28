/**
 * Zone Executor — runs raw host-language (TypeScript/JS) zone bodies
 * with $ctx, $self, and reagent injected into scope.
 */

export type ReagentStub = {
  emit: (eventName: string, data?: Record<string, unknown>) => void;
  invoke: (proto: unknown, args?: Record<string, unknown>) => unknown;
  spawn: (proto: unknown, args?: Record<string, unknown>) => void;
  return: (value: unknown) => void;
  break: () => void;
  resolve: (role: string, pipeline?: unknown[]) => unknown[];
  registry: { findByRole: (role: string) => unknown[]; get: (name: string) => unknown | undefined; all: () => unknown[] };
  stop: () => void;
};

export function createReagentStub(): ReagentStub {
  return {
    emit: (eventName, data) => {
      throw new EmitRequest(eventName, data);
    },
    invoke: (proto, args) => {
      throw new InvokeRequest(proto as string, args as Record<string, unknown> | undefined);
    },
    spawn: (proto, args) => {
      throw new SpawnRequest(proto as string, args as Record<string, unknown> | undefined);
    },
    return: (value) => {
      throw new ReturnValue(value);
    },
    break: () => {
      throw new BreakRequest();
    },
    resolve: (_role, _pipeline) => {
      throw new ResolveRequest(_role, _pipeline);
    },
    registry: {
      findByRole: () => [],
      get: () => undefined,
      all: () => [],
    },
    stop: () => {
      throw new StopRequest();
    },
  };
}

/** Sentinel thrown when a zone calls reagent.invoke() */
export class InvokeRequest {
  readonly __reagentInvoke = true;
  constructor(
    public readonly protoName: string,
    public readonly input?: Record<string, unknown>,
  ) {}
}

/** Sentinel thrown when a zone calls reagent.return() */
export class ReturnValue {
  readonly __reagentReturn = true;
  constructor(public readonly value: unknown) {}
}

/** Sentinel thrown when a zone calls reagent.spawn() */
export class SpawnRequest {
  readonly __reagentSpawn = true;
  constructor(
    public readonly protoName: string,
    public readonly input?: Record<string, unknown>,
  ) {}
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

/** Sentinel thrown when a zone calls reagent.resolve() */
export class ResolveRequest {
  readonly __reagentResolve = true;
  constructor(
    public readonly role: string,
    public readonly pipeline?: unknown[],
  ) {}
}

/** Sentinel thrown when a zone calls reagent.stop() */
export class StopRequest {
  readonly __reagentStop = true;
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
