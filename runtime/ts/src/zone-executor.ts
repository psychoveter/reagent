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
      console.log(`[reagent.emit] ${eventName}`, data ?? "");
    },
    invoke: (_proto, _args) => {
      console.log("[reagent.invoke] stub — not implemented in test runtime");
      return {};
    },
    spawn: (_proto, _args) => {
      console.log("[reagent.spawn] stub — not implemented in test runtime");
    },
    return: (_value) => {
      console.log("[reagent.return] stub — not implemented in test runtime");
    },
  };
}

/**
 * Execute a zone body string with $ctx, $self, reagent, and optional extras in scope.
 * Returns true if execution succeeded, false otherwise.
 */
export function executeZone(
  body: string,
  ctx: Record<string, unknown>,
  self: Record<string, unknown>,
  reagent: ReagentStub,
  extras?: Record<string, unknown>,
): boolean {
  try {
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
  } catch (err) {
    console.error(`[zone-executor] Error executing zone:`, err);
    return false;
  }
}
