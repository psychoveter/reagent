/**
 * ScatterCoordinator — streaming and partitioned scatter execution.
 *
 * Layer 1 (streaming): emits per-branch results immediately as each branch
 * completes, rather than waiting for all branches (await-all join).
 *
 * Layer 2 (partitioned): when branch count exceeds a configurable threshold,
 * automatically partitions the scatter into groups that can be distributed
 * across multiple AgentNodes / processes.
 */

export interface ScatterBranch<T = unknown> {
  index: number;
  item: T;
}

export interface ScatterResult<T = unknown> {
  index: number;
  item: T;
  result: unknown;
  error?: string;
  durationMs: number;
}

export interface ScatterPartition<T = unknown> {
  partitionId: number;
  branches: ScatterBranch<T>[];
}

export interface ScatterCoordinatorConfig {
  /** Threshold above which partitioning is enabled. Default 50. */
  partitionThreshold?: number;
  /** Max branches per partition. Default 25. */
  partitionSize?: number;
  /** Concurrency limit within a single partition. Default Infinity. */
  concurrencyLimit?: number;
}

export type OnBranchResult<T = unknown> = (result: ScatterResult<T>) => void;
export type BranchExecutor<T = unknown> = (branch: ScatterBranch<T>) => Promise<unknown>;

/**
 * Streaming scatter: execute branches and call onResult as each completes.
 * Returns aggregate results array when all done.
 */
export async function streamingScatter<T>(
  items: T[],
  executor: BranchExecutor<T>,
  onResult: OnBranchResult<T>,
  config?: ScatterCoordinatorConfig,
): Promise<ScatterResult<T>[]> {
  const concurrency = config?.concurrencyLimit ?? Infinity;
  const branches = items.map((item, index) => ({ index, item }));
  const results: ScatterResult<T>[] = [];

  if (concurrency === Infinity || concurrency >= branches.length) {
    const promises = branches.map(async (branch) => {
      const start = Date.now();
      try {
        const result = await executor(branch);
        const sr: ScatterResult<T> = {
          index: branch.index,
          item: branch.item,
          result,
          durationMs: Date.now() - start,
        };
        results.push(sr);
        onResult(sr);
      } catch (err: any) {
        const sr: ScatterResult<T> = {
          index: branch.index,
          item: branch.item,
          result: undefined,
          error: err.message ?? String(err),
          durationMs: Date.now() - start,
        };
        results.push(sr);
        onResult(sr);
      }
    });
    await Promise.all(promises);
  } else {
    let nextIdx = 0;
    const runNext = async (): Promise<void> => {
      while (nextIdx < branches.length) {
        const branch = branches[nextIdx++];
        const start = Date.now();
        try {
          const result = await executor(branch);
          const sr: ScatterResult<T> = {
            index: branch.index,
            item: branch.item,
            result,
            durationMs: Date.now() - start,
          };
          results.push(sr);
          onResult(sr);
        } catch (err: any) {
          const sr: ScatterResult<T> = {
            index: branch.index,
            item: branch.item,
            result: undefined,
            error: err.message ?? String(err),
            durationMs: Date.now() - start,
          };
          results.push(sr);
          onResult(sr);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, branches.length) }, () => runNext());
    await Promise.all(workers);
  }

  results.sort((a, b) => a.index - b.index);
  return results;
}

/**
 * Partition items into groups for distribution across nodes/processes.
 */
export function partitionBranches<T>(
  items: T[],
  config?: ScatterCoordinatorConfig,
): ScatterPartition<T>[] {
  const threshold = config?.partitionThreshold ?? 50;
  const partitionSize = config?.partitionSize ?? 25;

  if (items.length <= threshold) {
    return [
      {
        partitionId: 0,
        branches: items.map((item, index) => ({ index, item })),
      },
    ];
  }

  const partitions: ScatterPartition<T>[] = [];
  let partitionId = 0;

  for (let i = 0; i < items.length; i += partitionSize) {
    const slice = items.slice(i, i + partitionSize);
    partitions.push({
      partitionId: partitionId++,
      branches: slice.map((item, localIdx) => ({
        index: i + localIdx,
        item,
      })),
    });
  }

  return partitions;
}

/**
 * Execute a partitioned scatter: partition the items, execute each partition
 * (potentially on different nodes), and stream results.
 */
export async function partitionedScatter<T>(
  items: T[],
  executor: BranchExecutor<T>,
  onResult: OnBranchResult<T>,
  config?: ScatterCoordinatorConfig,
): Promise<ScatterResult<T>[]> {
  const partitions = partitionBranches(items, config);

  const allResults: ScatterResult<T>[] = [];

  const partitionPromises = partitions.map(async (partition) => {
    const partitionItems = partition.branches.map((b) => b.item);
    const partitionBranchMap = new Map<number, ScatterBranch<T>>();
    for (const b of partition.branches) {
      partitionBranchMap.set(b.index - partition.branches[0].index, b);
    }

    const results = await streamingScatter(
      partitionItems,
      async (localBranch) => {
        const globalBranch = partition.branches[localBranch.index];
        return executor(globalBranch);
      },
      (localResult) => {
        const globalResult: ScatterResult<T> = {
          ...localResult,
          index: partition.branches[localResult.index].index,
          item: partition.branches[localResult.index].item,
        };
        allResults.push(globalResult);
        onResult(globalResult);
      },
      config,
    );
    return results;
  });

  await Promise.all(partitionPromises);

  allResults.sort((a, b) => a.index - b.index);
  return allResults;
}
