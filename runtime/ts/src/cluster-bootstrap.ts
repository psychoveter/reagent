/**
 * ClusterBootstrap — convenience function to set up etcd-based cluster infrastructure.
 *
 * Ties together: EtcdManager → EtcdStateStore → LeaderElection → EtcdMembership.
 * Any entrypoint (main.ts, mcp-gate.ts) calls bootstrapCluster() to get a ready-to-use
 * StateStore with embedded etcd, or falls back to InMemoryStateStore in single-node mode.
 */

import { EtcdManager, type EtcdManagerConfig } from "./etcd-manager.js";
import { EtcdStateStore } from "./etcd-state-store.js";
import { LeaderElection } from "./leader-election.js";
import { InMemoryStateStore } from "./state-store.js";
import type { StateStore } from "./state-store.js";

export interface ClusterConfig {
  nodeId: string;
  /** Peer list for cluster mode, e.g. ["node-1=http://host1:2380","node-2=http://host2:2380"] */
  peers?: string[];
  /** etcd client port. Default: 2379 */
  clientPort?: number;
  /** etcd peer port. Default: 2380 */
  peerPort?: number;
  /** etcd version. Default: 3.6.8 */
  etcdVersion?: string;
  /** Override etcd binary cache directory. */
  etcdCacheDir?: string;
  /** Connect to an external etcd instead of starting embedded. */
  externalEtcdHosts?: string[];
}

export interface ClusterHandle {
  stateStore: StateStore;
  cronLeaderElection: LeaderElection | undefined;
  /** Null if using InMemoryStateStore (single-node dev mode without etcd). */
  etcdManager: EtcdManager | null;
  /** Shut down etcd and release resources. */
  shutdown(): Promise<void>;
}

/**
 * Bootstrap cluster infrastructure.
 *
 * - If `peers` is provided: starts embedded etcd in multi-member mode.
 * - If no `peers` and no `externalEtcdHosts`: starts single-member embedded etcd.
 * - If `externalEtcdHosts` is provided: connects to external etcd (no embedded process).
 *
 * Returns a handle with stateStore, cronLeaderElection, and shutdown().
 */
export async function bootstrapCluster(config: ClusterConfig): Promise<ClusterHandle> {
  const {
    nodeId,
    peers,
    clientPort = 2379,
    peerPort = 2380,
    etcdVersion,
    etcdCacheDir,
    externalEtcdHosts,
  } = config;

  let etcdManager: EtcdManager | null = null;
  let hosts: string[];

  if (externalEtcdHosts && externalEtcdHosts.length > 0) {
    hosts = externalEtcdHosts;
  } else {
    const managerConfig: EtcdManagerConfig = {
      nodeId,
      version: etcdVersion,
      clientPort,
      peerPort,
      cacheDir: etcdCacheDir,
    };

    if (peers && peers.length > 0) {
      managerConfig.initialCluster = peers;
      managerConfig.initialClusterState = "new";
    }

    etcdManager = new EtcdManager(managerConfig);
    await etcdManager.start();
    hosts = [etcdManager.clientUrl];
  }

  const stateStore = new EtcdStateStore({ hosts });

  const cronLeaderElection = new LeaderElection({
    stateStore,
    leaderKey: "/cron/leader",
    candidateId: nodeId,
  });

  return {
    stateStore,
    cronLeaderElection,
    etcdManager,
    shutdown: async () => {
      await cronLeaderElection.stop();
      await stateStore.close();
      if (etcdManager) {
        await etcdManager.stop();
      }
    },
  };
}

/**
 * Parse --peers CLI flag from argv.
 * Format: --peers "node-1=http://host1:2380,node-2=http://host2:2380"
 */
export function parsePeersArg(args: string[]): string[] | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--peers" && args[i + 1]) {
      return args[i + 1].split(",");
    }
  }
  return undefined;
}

/**
 * Parse --etcd-hosts CLI flag from argv.
 * Format: --etcd-hosts "http://host1:2379,http://host2:2379"
 */
export function parseEtcdHostsArg(args: string[]): string[] | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--etcd-hosts" && args[i + 1]) {
      return args[i + 1].split(",");
    }
  }
  return undefined;
}
