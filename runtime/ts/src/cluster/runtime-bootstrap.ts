import { LeaderElection } from "./leader-election.js";
import { EtcdMembership } from "./etcd-membership.js";
import { EtcdStateStore } from "./etcd-state-store.js";
import { InMemoryStateStore, type StateStore } from "./state-store.js";
import { NatsNodeLink } from "../network/nats-node-link.js";
import type { ReagentController } from "../controller/reagent-controller.js";
import type { RuntimeConfig } from "./runtime-config.js";

export interface RuntimeBootstrapHandle {
  stateStore: StateStore;
  cronLeaderElection?: LeaderElection;
  membership?: EtcdMembership;
  shutdown(): Promise<void>;
}

export async function bootstrapRuntime(
  config: RuntimeConfig,
  rc?: ReagentController,
  opts?: {
    stateStore?: StateStore;
    onRemoteAgent?: (agentName: string, remoteNodeId: string) => Promise<void> | void;
    onRemoteAgentRemoved?: (agentName: string) => void;
    onNodeJoin?: (nodeId: string) => void;
    onNodeLeave?: (nodeId: string) => Promise<void> | void;
  },
): Promise<RuntimeBootstrapHandle> {
  const stateStore = opts?.stateStore ?? (config.stateStore.kind === "etcd"
    ? new EtcdStateStore({ hosts: config.stateStore.hosts })
    : new InMemoryStateStore());

  const cronLeaderElection = config.stateStore.kind === "etcd"
    ? new LeaderElection({
        stateStore,
        leaderKey: "/cron/leader",
        candidateId: config.nodeId,
      })
    : undefined;

  let membership: EtcdMembership | undefined;

  if (config.membership?.enabled) {
    membership = new EtcdMembership({
      stateStore,
      nodeId: config.nodeId,
      leaseTtlSeconds: config.membership.leaseTtlSeconds,
      onRemoteAgent: async (agentName, remoteNodeId) => {
        if (rc && config.messagePlane?.kind === "nats") {
          const existing = rc.inspect().routing[agentName];
          if (existing !== remoteNodeId) {
            const link = new NatsNodeLink({
              localNodeId: config.nodeId,
              remoteNodeId,
              natsUrl: config.messagePlane.url,
            });
            await link.connect();
            rc.addNodeLink(link);
          }
          rc.registerRemoteAgent(agentName, remoteNodeId);
        }
        await opts?.onRemoteAgent?.(agentName, remoteNodeId);
      },
      onRemoteAgentRemoved: (agentName) => {
        opts?.onRemoteAgentRemoved?.(agentName);
      },
      onNodeJoin: (nodeId) => {
        opts?.onNodeJoin?.(nodeId);
      },
      onNodeLeave: async (nodeId) => {
        await opts?.onNodeLeave?.(nodeId);
      },
    });
    await membership.start();
  }

  return {
    stateStore,
    cronLeaderElection,
    membership,
    shutdown: async () => {
      await membership?.stop();
      await cronLeaderElection?.stop();
      await stateStore.close();
    },
  };
}
