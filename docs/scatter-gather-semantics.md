# Scatter-Gather Semantics RFC

**Status**: Draft  
**Milestone**: Wave 1.4 (Foundation)  
**Author**: Reagent team  
**Date**: 2026-02-21

## 1. Problem Statement

The current scatter implementation uses `Object.create(this.ctx)` to give each branch a
prototypal copy of `$ctx`. This approach has several issues:

1. **Shared-parent mutation**: Operations like `$ctx.bids.push(x)` in a branch
   mutate the parent context's array (because the array is inherited, not cloned).
   This makes branch results nondeterministic and order-dependent.

2. **Scaling ceiling**: All branches execute sequentially via `await` in the same
   `ProtocolInstance`, limiting throughput. There is no mechanism to distribute
   branches across multiple agent nodes.

3. **No gather contract**: There is no explicit gather/reduce step; branches
   simply write to the shared parent context, and the coordinator reads it after
   all branches complete. This is implicit and fragile.

4. **Engine extraction dependency**: The `ProtocolEngine` (implemented in Wave 2.1)
   emits `ScatterRequired` / `ScatterGatherComplete` events. The engine does not
   own branch execution — it delegates to the orchestrating layer. The
   current tight coupling of scatter logic inside `ProtocolInstance` prevents
   clean extraction.

## 2. Current Implementation

### TypeScript (`protocol-instance.ts`)

```typescript
const branchPromises = list.map(async (item, idx) => {
  const branchCtx = Object.create(this.ctx);     // prototypal inheritance
  branchCtx._scatterItem = item;
  branchCtx._scatterIdx = idx;
  const branchRunner = new BranchRunner(/* ... */);
  branchRunner.ctx = branchCtx;
  await branchRunner.run(branchStartId);
});
await Promise.all(branchPromises);
```

### Python (`protocol_instance.py`)

```python
branch_ctx = dict(self._ctx)   # shallow copy — arrays are still shared
branch_ctx["_scatterItem"] = item
branch_ctx["_scatterIdx"] = idx
```

### IR Shape

```json
{
  "id": "scatter_1",
  "kind": "scatter",
  "data": {
    "kind": "scatter",
    "collection": "$ctx.items",
    "itemRole": "worker",
    "branchStartIds": ["branch_2"]
  }
}
```

Transitions from scatter use `label.kind = "branch"` with `branchIndex`.

## 3. Design: Two-Layer Scatter

### 3.1 Layer 1 — Immutable Branch Context

**Goal**: Eliminate shared-parent mutation, enable per-branch result return.

**Change**: Replace `Object.create(this.ctx)` with a deep clone:

```typescript
const branchCtx = structuredClone(this.ctx);
branchCtx._scatterItem = item;
branchCtx._scatterIdx = idx;
```

Each branch runs in isolation. When it completes, the orchestrating layer
receives the branch's final `$ctx` as part of the `AgentResponse`:

```typescript
type AgentResponse =
  | { type: "ctx_update"; ctx: Record<string, unknown> }
  | { type: "scatter_result"; index: number; ctx: Record<string, unknown> }
  | ...;
```

**Gather semantics**: After all branches complete, the coordinator invokes
a gather function (if specified in the IR) or applies a default merge:

```
scatter $ctx.items as worker {
  // branch body
} gather(results) {
  $ctx.bids = results.map(r => r.bid)
}
```

If no `gather` block is present, the default behavior collects each branch's
modified `$ctx` into `$ctx._scatterResults[]` (a flat array of branch ctx
objects).

**Backward compatibility**: For `N < SCATTER_THRESHOLD` (default: 10), the
sequential execution within a single `ProtocolInstance` is preserved with
the only difference being deep clone instead of `Object.create`. Existing
protocols that rely on `$ctx.bids.push(x)` will break — they must migrate
to the gather pattern. This is a documented breaking change in v2.

### 3.2 Layer 2 — Partitioned Scatter (Distributed)

**Goal**: Scale scatter to 100+ agents across multiple nodes.

**Change**: When `N >= SCATTER_THRESHOLD`, the RC auto-partitions branches
across available `AgentNode` instances:

1. RC receives `ScatterRequired` event from `ProtocolEngine`
2. RC computes partition count: `P = ceil(N / PARTITION_SIZE)`
3. RC assigns each partition to an `AgentNode` (round-robin or affinity-based)
4. Each node runs its partition's branches locally (Layer 1 semantics)
5. Node reports partition results back to the RC
6. RC assembles all partition results and emits `ScatterGatherComplete`
7. `ProtocolEngine` advances to the join state

**Wire format** (between RC and remote nodes):

```json
{
  "type": "ScatterPartition",
  "instanceId": "...",
  "partitionId": 0,
  "items": [...],
  "branchIR": { ... },
  "parentCtx": { ... }
}
```

```json
{
  "type": "PartitionResult",
  "instanceId": "...",
  "partitionId": 0,
  "results": [
    { "index": 0, "ctx": { ... } },
    { "index": 1, "ctx": { ... } }
  ]
}
```

## 4. ProtocolEngine Integration

The `ProtocolEngine` is a pure FSM (implemented in Wave 2.1). When it reaches a scatter
state, it does not execute branches itself. Instead:

1. Engine emits `ScatterRequired`:
   ```typescript
   { type: "scatter_required", items: unknown[], bodyGraph: string }
   ```

2. The orchestrating layer (RC wrapper or `ProtocolInstance` thin wrapper)
   decides execution strategy:
   - **Small N**: Run branches in-process (Layer 1)
   - **Large N**: Partition across nodes (Layer 2)

3. After all results are gathered, the orchestrating layer feeds a
   `ScatterGatherComplete` response back to the engine:
   ```typescript
   { type: "scatter_complete", results: Array<{ index: number; ctx: Record<string, unknown> }> }
   ```

4. Engine applies gather logic (or default merge) and advances to join.

This keeps `ProtocolEngine` complexity low (~800 LOC target) while enabling
arbitrary scatter scaling strategies in the orchestrating layer.

## 5. IR Extensions

### 5.1 Gather Block (optional)

```json
{
  "id": "scatter_1",
  "kind": "scatter",
  "data": {
    "kind": "scatter",
    "collection": "$ctx.items",
    "itemRole": "worker",
    "branchStartIds": ["branch_2"],
    "gatherZone": "$ctx.bids = $results.map(r => r.bid)",
    "gatherAsync": false
  }
}
```

`$results` is injected by the engine — an array of per-branch `$ctx` snapshots.

### 5.2 Scatter Threshold Config

In `reagent.json`:

```json
{
  "runtime": {
    "scatterThreshold": 10,
    "scatterPartitionSize": 25
  }
}
```

## 6. Migration Guide

### Before (v1, shared mutation)

```reagent
scatter $ctx.buyers as buyer {
  buyer -> seller: Bid { amount: $ctx.calculateBid() }
  seller -> buyer: BidResult
  ts {
    $ctx.bids.push($ctx.msg.result)   // mutates parent!
  }
}
```

### After (v2, gather pattern)

```reagent
scatter $ctx.buyers as buyer {
  buyer -> seller: Bid { amount: $ctx.calculateBid() }
  seller -> buyer: BidResult
  ts {
    $ctx.bidResult = $ctx.msg.result
  }
} gather(results) {
  $ctx.bids = results.map(r => r.bidResult)
}
```

## 7. Testing Strategy

- **Unit**: `ProtocolEngine` emits `ScatterRequired` with correct items
- **Integration**: Layer 1 (deep clone) produces independent branch contexts
- **E2E**: auction-sim runs with new scatter semantics, same outcome
- **Scale**: 100+ agents across 4 partitions (Layer 2), verify all results collected
- **Backward compat**: Protocols without `gather` block use default merge
- **Regression**: Existing m9-scatter-async tests pass

## 8. Timeline

| Phase | Description | Wave |
|-------|-------------|------|
| RFC (this doc) | Design agreement | 1.4 |
| Deep clone + gather | Replace `Object.create` | 2.1 |
| Engine integration | `ScatterRequired` events | 2.1 |
| Partitioned scatter | Cross-node distribution | 3.3 |
| `gather` syntax | Compiler extension | 3.3 |
