export type RoleBindingCardinality = "single" | "many";

export type RoleBindingValue = {
  cardinality: RoleBindingCardinality;
  agents: string[];
};

export type LegacyRoleBindingMap = Record<string, string | string[] | RoleBindingValue>;
export type RoleBindingMap = Record<string, RoleBindingValue>;

export type RoleBindingResolver = (
  protocolName: string,
  roleName: string,
) => RoleBindingValue | undefined;

export type RoleBindingSource = RoleBindingMap | RoleBindingResolver;

function uniqueAgents(agents: string[]): string[] {
  return [...new Set(agents.filter(Boolean))];
}

export function normalizeRoleBindingValue(
  value: string | string[] | RoleBindingValue,
  preferredCardinality?: RoleBindingCardinality,
): RoleBindingValue {
  if (typeof value === "string") {
    return { cardinality: preferredCardinality ?? "single", agents: value ? [value] : [] };
  }
  if (Array.isArray(value)) {
    const agents = uniqueAgents(value);
    return {
      cardinality: preferredCardinality ?? (agents.length <= 1 ? "single" : "many"),
      agents,
    };
  }
  return {
    cardinality: value.cardinality,
    agents: uniqueAgents(value.agents),
  };
}

export function normalizeRoleBindingMap(source?: LegacyRoleBindingMap): RoleBindingMap {
  const normalized: RoleBindingMap = {};
  if (!source) return normalized;
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    normalized[key] = normalizeRoleBindingValue(value);
  }
  return normalized;
}

export function setRoleBinding(
  bindings: RoleBindingMap,
  protocolName: string,
  roleName: string,
  agentName: string | string[] | RoleBindingValue,
  preferredCardinality?: RoleBindingCardinality,
): void {
  bindings[`${protocolName}.${roleName}`] = normalizeRoleBindingValue(agentName, preferredCardinality);
}

export function mergeRoleBindings(
  protocolName: string,
  target: RoleBindingMap,
  source?: LegacyRoleBindingMap | RoleBindingMap,
): RoleBindingMap {
  if (!source) return target;
  const normalized = normalizeRoleBindingMap(source);
  for (const [key, value] of Object.entries(normalized)) {
    if (key.includes(".")) {
      target[key] = value;
      continue;
    }
    setRoleBinding(target, protocolName, key, value);
  }
  return target;
}

export function resolveRoleBinding(
  source: RoleBindingSource,
  protocolName: string,
  roleName: string,
): RoleBindingValue | undefined {
  if (typeof source === "function") {
    return source(protocolName, roleName);
  }
  return source[`${protocolName}.${roleName}`];
}

export function resolveSingleRoleBinding(
  source: RoleBindingSource,
  protocolName: string,
  roleName: string,
): string | undefined {
  const resolved = resolveRoleBinding(source, protocolName, roleName);
  if (!resolved) return undefined;
  if (resolved.cardinality === "many") return undefined;
  return resolved.agents[0];
}
