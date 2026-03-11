/**
 * Wave 3.3: Scatter scaling tests.
 *
 * Layer 1: Streaming scatter — results arrive incrementally.
 * Layer 2: Partitioned scatter — auto-partition when N > threshold, test 100+.
 */

import {
  streamingScatter,
  partitionBranches,
  partitionedScatter,
} from "../ts/src/core/scatter-coordinator.js";
import type { ScatterResult, ScatterBranch } from "../ts/src/core/scatter-coordinator.js";

const results: Array<{ name: string; pass: boolean; error?: string }> = [];

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    results.push({ name, pass: false, error: err.message ?? String(err) });
    console.log(`  ✗ ${name} — ${err.message ?? err}`);
  }
}

async function main(): Promise<void> {
  console.log("=== Wave 3.3: Scatter Scaling Tests ===\n");

  // ── Layer 1: Streaming scatter ──

  await run("SS1: Streaming scatter emits results incrementally", async () => {
    const items = [10, 20, 30, 40, 50];
    const received: number[] = [];

    await streamingScatter(
      items,
      async (branch: ScatterBranch<number>) => {
        await new Promise((r) => setTimeout(r, branch.item));
        return branch.item * 2;
      },
      (result: ScatterResult<number>) => {
        received.push(result.index);
      },
    );

    if (received.length !== 5) throw new Error(`Expected 5 results, got ${received.length}`);
    // The 10ms branch should complete before the 50ms branch
    if (received[0] !== 0) throw new Error(`First result should be index 0 (10ms), got ${received[0]}`);
  });

  await run("SS2: Streaming scatter captures errors per branch", async () => {
    const items = ["ok", "fail", "ok"];

    const res = await streamingScatter(
      items,
      async (branch: ScatterBranch<string>) => {
        if (branch.item === "fail") throw new Error("branch failed");
        return `processed-${branch.item}`;
      },
      () => {},
    );

    const failed = res.filter((r) => r.error);
    if (failed.length !== 1) throw new Error(`Expected 1 failed, got ${failed.length}`);
    if (failed[0].index !== 1) throw new Error(`Failed should be index 1`);
    if (!failed[0].error!.includes("branch failed")) throw new Error(`Wrong error: ${failed[0].error}`);
  });

  await run("SS3: Streaming scatter with concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const items = Array.from({ length: 20 }, (_, i) => i);

    await streamingScatter(
      items,
      async () => {
        current++;
        if (current > maxConcurrent) maxConcurrent = current;
        await new Promise((r) => setTimeout(r, 10));
        current--;
        return "done";
      },
      () => {},
      { concurrencyLimit: 5 },
    );

    if (maxConcurrent > 5) throw new Error(`Max concurrent ${maxConcurrent} exceeded limit 5`);
    if (maxConcurrent < 2) throw new Error(`Max concurrent ${maxConcurrent} too low (expected at least 2)`);
  });

  await run("SS4: Streaming scatter results sorted by index", async () => {
    const items = [50, 10, 30, 20, 40];

    const res = await streamingScatter(
      items,
      async (branch: ScatterBranch<number>) => {
        await new Promise((r) => setTimeout(r, branch.item));
        return branch.item;
      },
      () => {},
    );

    for (let i = 0; i < res.length; i++) {
      if (res[i].index !== i) throw new Error(`Result[${i}] has index ${res[i].index}, expected ${i}`);
    }
  });

  // ── Layer 2: Partitioned scatter ──

  await run("PS1: partitionBranches does not partition below threshold", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const partitions = partitionBranches(items, { partitionThreshold: 50, partitionSize: 25 });

    if (partitions.length !== 1) throw new Error(`Expected 1 partition, got ${partitions.length}`);
    if (partitions[0].branches.length !== 30) throw new Error(`Expected 30 branches`);
  });

  await run("PS2: partitionBranches auto-partitions above threshold", async () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    const partitions = partitionBranches(items, { partitionThreshold: 50, partitionSize: 25 });

    if (partitions.length !== 5) throw new Error(`Expected 5 partitions (120/25=4.8→5), got ${partitions.length}`);

    // Verify all items are present
    const allIndices = partitions.flatMap((p) => p.branches.map((b) => b.index));
    allIndices.sort((a, b) => a - b);
    for (let i = 0; i < 120; i++) {
      if (allIndices[i] !== i) throw new Error(`Missing index ${i}`);
    }
  });

  await run("PS3: partitionedScatter with 100+ agents — all results collected", async () => {
    const agentCount = 120;
    const items = Array.from({ length: agentCount }, (_, i) => `agent-${i}`);
    const received: ScatterResult<string>[] = [];

    const res = await partitionedScatter(
      items,
      async (branch: ScatterBranch<string>) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return `result-${branch.item}`;
      },
      (result) => {
        received.push(result);
      },
      { partitionThreshold: 30, partitionSize: 25 },
    );

    if (res.length !== agentCount) throw new Error(`Expected ${agentCount} results, got ${res.length}`);
    if (received.length !== agentCount) throw new Error(`Expected ${agentCount} streamed results, got ${received.length}`);

    for (let i = 0; i < agentCount; i++) {
      if (res[i].index !== i) throw new Error(`Final result[${i}] has index ${res[i].index}`);
      if (res[i].result !== `result-agent-${i}`) throw new Error(`Wrong result for index ${i}: ${res[i].result}`);
    }
  });

  await run("PS4: partitionedScatter handles errors across partitions", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const errorIndices = new Set([7, 33, 77, 99]);

    const res = await partitionedScatter(
      items,
      async (branch: ScatterBranch<number>) => {
        if (errorIndices.has(branch.item)) throw new Error(`fail-${branch.item}`);
        return branch.item * 10;
      },
      () => {},
      { partitionThreshold: 30, partitionSize: 25 },
    );

    const errors = res.filter((r) => r.error);
    if (errors.length !== errorIndices.size) {
      throw new Error(`Expected ${errorIndices.size} errors, got ${errors.length}`);
    }
    for (const e of errors) {
      if (!errorIndices.has(e.item as number)) {
        throw new Error(`Unexpected error at index ${e.index}`);
      }
    }

    const successes = res.filter((r) => !r.error);
    if (successes.length !== 100 - errorIndices.size) {
      throw new Error(`Expected ${100 - errorIndices.size} successes, got ${successes.length}`);
    }
  });

  await run("PS5: Large scatter — 500 items across partitions", async () => {
    const count = 500;
    const items = Array.from({ length: count }, (_, i) => i);
    let streamedCount = 0;

    const start = Date.now();
    const res = await partitionedScatter(
      items,
      async (branch: ScatterBranch<number>) => branch.item + 1,
      () => { streamedCount++; },
      { partitionThreshold: 50, partitionSize: 50 },
    );
    const elapsed = Date.now() - start;

    if (res.length !== count) throw new Error(`Expected ${count} results, got ${res.length}`);
    if (streamedCount !== count) throw new Error(`Expected ${count} streamed, got ${streamedCount}`);

    const sum = res.reduce((acc, r) => acc + (r.result as number), 0);
    const expected = (count * (count + 1)) / 2;
    if (sum !== expected) throw new Error(`Sum mismatch: ${sum} !== ${expected}`);

    console.log(`    (500 branches in ${elapsed}ms)`);
  });

  console.log(
    `\n${results.filter((r) => r.pass).length} passed, ${results.filter((r) => !r.pass).length} failed out of ${results.length}`
  );
  if (results.some((r) => !r.pass)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
