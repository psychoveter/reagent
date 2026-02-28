## M11-STATE: StateStore abstraction + resolve runtime — COMPLETED

All 12 tasks (S.1–S.12) completed. Introduces `StateStore` — an abstract key-value interface
behind which all runtime state management operates.

### StateStore interface

```typescript
interface StateStore {
  get(key: string): Promise<StoreValue | null>;
  put(key: string, value: StoreValue, opts?: { lease?: string }): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<StoreEntry[]>;
  putIfAbsent(key: string, value: StoreValue, opts?: { lease?: string }): Promise<boolean>;
  watch(prefix: string, cb: (event: WatchEvent) => void): Disposable;
  createLease(ttlSeconds: number): Promise<Lease>;
}
```

### Implementations

| Backend | Use case | Persistence | Consensus |
|---------|----------|-------------|-----------|
| `InMemoryStateStore` | dev, tests, single-node | no | no |
| `EtcdStateStore` | cluster, production | yes (WAL) | yes (Raft) |

`InMemoryStateStore` is the default. Zero config, zero deps.

### What StateStore stores

| Key prefix | Data | Used by |
|---|---|---|
| `/agents/{name}` | `AgentRegistration` (role, tags, capabilities, labels, nodeId) | Resolve policies, `reagent.registry` |
| `/triggers/cron/leader` | Lease-based leader election | CronAgent singleton (cluster) |
| `/triggers/locks/{triggerId}/{eventId}` | CAS lock | Trigger dedup (cluster-wide) |
| `/policies/{proto}/{triggerId}/state` | Stateful policy state (roundRobin cursor, etc.) | `ResolvePolicyEvaluator` |
| `/instances/{instanceId}` | Running protocol instance metadata | `leastLoaded` policy, observability |
| `/nodes/{nodeId}` | Node lease + metadata | Membership, failure detection |

### Tasks (all complete)

| # | Task | Area | Status |
|---|------|------|--------|
| S.1 | `StateStore` interface + `InMemoryStateStore` implementation | runtime/ts | ✅ Done |
| S.2 | `StateStoreAgentRegistry` implementing `AgentRegistry` (local cache + watch) | runtime/ts | ✅ Done |
| S.3 | `rc.registerAgent()` writes to StateStore instead of local Map | runtime/ts | ✅ Done |
| S.4 | `ResolvePolicyEvaluator` in RC — reads agent registry, evaluates resolve pipelines | runtime/ts | ✅ Done |
| S.5 | TriggerMatcher integration: resolve static participants via `resolveMap` from IR | runtime/ts | ✅ Done |
| S.6 | Zone-level `reagent.resolve()` + `reagent.registry` for dynamic resolution | runtime/ts | ✅ Done |
| S.7 | Spawn lifecycle runtime: protocol-scoped (default) + `persistent` flag | runtime/ts | ✅ Done |
| S.8 | Stateful resolve policies: `roundRobin`, `leastLoaded` (backed by StateStore) | runtime/ts | ✅ Done |
| S.9 | Custom resolve policies: `rc.registerResolvePolicy()` | runtime/ts | ✅ Done |
| S.10 | Py runtime: `StateStore` interface + `InMemoryStateStore` + registry + resolve + spawn | runtime/py | ✅ Done |
| S.11 | Tests: registry CRUD, resolve pipeline evaluation, spawn lifecycle, stateful policies | tests | ✅ Done |
| S.12 | Docs: update rc-spec, backlog status | docs | ✅ Done |
