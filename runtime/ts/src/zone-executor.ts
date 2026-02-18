/**
 * Zone Executor — runs raw host-language (TypeScript/JS) zone bodies
 * with $ctx, $self, and reagent injected into scope.
 */

export type ReagentStub = {
  emit: (eventName: string, data?: Record<string, unknown>) => void;
  invoke: (proto: unknown, args?: Record<string, unknown>) => unknown;
  spawn: (proto: unknown, args?: Record<string, unknown>) => void;
  return: (value: unknown) => void;
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

/**
 * Execute a zone body string with $ctx, $self, reagent, and optional extras in scope.
 * Throws ZoneError if the zone throws (used for try/catch routing).
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

export class ZoneError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ZoneError";
  }
}
