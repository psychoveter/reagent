import type { NodeControlEndpointRef, NodeRegistration } from "../contracts/types.js";
import type { StateStore } from "../cluster/state-store.js";
import type { AgentRegistration } from "../cluster/state-store-agent-registry.js";

const NODES_PREFIX = "/nodes/";
const AGENTS_PREFIX = "/agents/";

export interface NodeEndpointResolver {
  resolveNode(nodeId: string): Promise<NodeControlEndpointRef>;
  resolveAgent(agentName: string): Promise<{ nodeId: string; endpoint: NodeControlEndpointRef }>;
  listNodes(): Promise<NodeRegistration[]>;
}

function parseJson<T>(value: string | Buffer): T {
  const text = typeof value === "string" ? value : value.toString("utf8");
  return JSON.parse(text) as T;
}

export class StoreBackedNodeEndpointResolver implements NodeEndpointResolver {
  constructor(private readonly store: StateStore) {}

  async resolveNode(nodeId: string): Promise<NodeControlEndpointRef> {
    const entry = await this.store.get(`${NODES_PREFIX}${nodeId}`);
    if (!entry) {
      throw new Error(`Node ${nodeId} is not registered`);
    }
    const node = parseJson<NodeRegistration>(entry);
    if (!node.control?.url) {
      throw new Error(`Node ${nodeId} has no control endpoint`);
    }
    return node.control;
  }

  async resolveAgent(agentName: string): Promise<{ nodeId: string; endpoint: NodeControlEndpointRef }> {
    const entry = await this.store.get(`${AGENTS_PREFIX}${agentName}`);
    if (!entry) {
      throw new Error(`Agent ${agentName} is not registered`);
    }
    const agent = parseJson<AgentRegistration>(entry);
    if (!agent.nodeId) {
      throw new Error(`Agent ${agentName} is not addressable`);
    }
    return {
      nodeId: agent.nodeId,
      endpoint: await this.resolveNode(agent.nodeId),
    };
  }

  async listNodes(): Promise<NodeRegistration[]> {
    const entries = await this.store.list(NODES_PREFIX);
    return entries.map((entry) => parseJson<NodeRegistration>(entry.value));
  }
}
