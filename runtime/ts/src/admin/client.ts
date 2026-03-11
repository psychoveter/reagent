import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AgentRegistration } from "../cluster/state-store-agent-registry.js";
import type { StateStore } from "../cluster/state-store.js";
import type { NodeRegistration } from "../contracts/types.js";
import { DirectStateStoreProvider, type StateStoreProvider } from "./state-store-provider.js";
import { NodeControlClient } from "./node-control-client.js";
import { StoreBackedNodeEndpointResolver, type NodeEndpointResolver } from "./node-endpoint-resolver.js";

export type AdminResponse = {
  rap: string;
  id?: string;
  payload: Record<string, unknown>;
};

export type ListAgentsArgs = {
  role?: string;
  protocolName?: string;
  status?: string;
  filter?: string;
  limit?: number;
  offset?: number;
};

export interface AdminClientConfig {
  legacyAdminUrl?: string;
  stateStoreProvider?: StateStoreProvider;
  nodeEndpointResolver?: NodeEndpointResolver;
}

const NODES_PREFIX = "/nodes/";
const AGENTS_PREFIX = "/agents/";

function decodeJson<T>(value: string | Buffer): T {
  const raw = typeof value === "string" ? value : value.toString("utf8");
  return JSON.parse(raw) as T;
}

export class AdminClient {
  private readonly legacyAdminUrl?: string;
  private readonly stateStoreProvider?: StateStoreProvider;
  private readonly providedResolver?: NodeEndpointResolver;
  private stateStorePromise: Promise<StateStore> | null = null;
  private resolverPromise: Promise<NodeEndpointResolver> | null = null;

  constructor(config: string | AdminClientConfig) {
    if (typeof config === "string") {
      this.legacyAdminUrl = config;
      return;
    }
    this.legacyAdminUrl = config.legacyAdminUrl;
    this.stateStoreProvider = config.stateStoreProvider;
    this.providedResolver = config.nodeEndpointResolver;
  }

  async send(rap: string, payload: Record<string, unknown>): Promise<AdminResponse> {
    if (!this.legacyAdminUrl) {
      throw new Error(`Legacy RAP transport is unavailable for ${rap}`);
    }
    const id = randomUUID();
    const ws = new WebSocket(this.legacyAdminUrl);

    return await new Promise((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ rap, id, payload }));
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as { rap?: string; id?: string; payload?: Record<string, unknown> };
          if (msg.id !== id) return;
          resolve({
            rap: msg.rap ?? "",
            id: msg.id,
            payload: msg.payload ?? {},
          });
          ws.close();
        } catch (err) {
          reject(err);
          ws.close();
        }
      });

      ws.on("error", reject);
    });
  }

  async compileSource(rgSource: string, fileName = "input.rg"): Promise<AdminResponse> {
    return this.send("Compile", { rgSource, fileName });
  }

  async deployProject(args: {
    deployment: Record<string, unknown>;
    irGraphs: Record<string, unknown>;
    roleIRs: Record<string, unknown>;
    sourceMap?: Record<string, unknown>;
    projectVersion?: string;
    agentRegistrations?: Record<string, unknown>;
  }): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("DeployProject", {
        deployment: args.deployment,
        irGraphs: args.irGraphs,
        roleIRs: args.roleIRs,
        sourceMap: args.sourceMap,
        projectVersion: args.projectVersion,
        agentRegistrations: args.agentRegistrations,
      });
    }

    const nodes = await this.listNodeRegistrations();
    const results: Array<{ nodeId: string; deployedAgents: string[] }> = [];
    for (const node of nodes) {
      if (!node.control?.url) continue;
      const client = new NodeControlClient(node.control.url);
      const payload = await client.request("DeployProject", {
        deployment: args.deployment,
        irGraphs: args.irGraphs,
        roleIRs: args.roleIRs,
        sourceMap: args.sourceMap,
        projectVersion: args.projectVersion,
        agentRegistrations: args.agentRegistrations,
      });
      results.push({
        nodeId: node.nodeId,
        deployedAgents: (payload.deployedAgents as string[]) ?? [],
      });
      client.close();
    }
    return {
      rap: "DeployProjectSuccess",
      payload: {
        nodes: results,
      },
    };
  }

  async triggerProtocol(args: {
    agentName: string;
    protocolName: string;
    input?: Record<string, unknown>;
    instanceId?: string;
    mode?: string;
    sessionId?: string;
    breakpoints?: string[];
    resolveOverrides?: Record<string, unknown>;
  }): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("TriggerOnCluster", {
        agentName: args.agentName,
        protocolName: args.protocolName,
        input: args.input ?? {},
        instanceId: args.instanceId,
        mode: args.mode,
        sessionId: args.sessionId,
        breakpoints: args.breakpoints,
        resolveOverrides: args.resolveOverrides,
      });
    }

    const resolver = await this.getResolver();
    const { endpoint, nodeId } = await resolver.resolveAgent(args.agentName);
    const client = new NodeControlClient(endpoint.url);
    const payload = await client.request("TriggerProtocol", {
      agentName: args.agentName,
      protocolName: args.protocolName,
      input: args.input ?? {},
      instanceId: args.instanceId,
      mode: args.mode,
      sessionId: args.sessionId,
      breakpoints: args.breakpoints,
      resolveOverrides: args.resolveOverrides,
    });
    client.close();
    return {
      rap: "TriggerAccepted",
      payload: {
        nodeId,
        ...payload,
      },
    };
  }

  async inspectNode(nodeId: string): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("NodeInspect", { nodeId });
    }
    const resolver = await this.getResolver();
    const endpoint = await resolver.resolveNode(nodeId);
    const client = new NodeControlClient(endpoint.url);
    const payload = await client.request("InspectNode", { nodeId });
    client.close();
    return {
      rap: "NodeInspectResult",
      payload,
    };
  }

  async clusterStatus(): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("ClusterStatus", {});
    }

    const store = await this.getStateStore();
    const nodes = await this.listNodeRegistrations();
    const agents = (await store.list(AGENTS_PREFIX)).map((entry) => decodeJson<AgentRegistration>(entry.value));
    const protocols = new Map<string, { name: string; version: string; nodeId: string; boundAgents: string[] }>();

    for (const node of nodes) {
      if (!node.control?.url) continue;
      try {
        const inspected = await this.inspectNode(node.nodeId);
        const nodeProtocols = (inspected.payload.protocols as Array<{ name: string; version: string; agents: string[] }>) ?? [];
        for (const protocol of nodeProtocols) {
          const key = `${node.nodeId}:${protocol.name}`;
          protocols.set(key, {
            name: protocol.name,
            version: protocol.version ?? "0.0.0",
            nodeId: node.nodeId,
            boundAgents: protocol.agents ?? [],
          });
        }
      } catch {
        // Best-effort aggregation.
      }
    }

    return {
      rap: "ClusterStatusResponse",
      payload: {
        nodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          status: "connected",
          lastSeen: Date.now(),
          controlUrl: node.control?.url,
        })),
        agents: agents.map((agent) => ({
          agentName: agent.name,
          roleName: agent.role,
          protocolName: String(agent.metadata?.protocolName ?? ""),
          nodeId: agent.nodeId ?? "",
          status: agent.lifecycle,
        })),
        protocols: [...protocols.values()],
        timestamp: Date.now(),
      },
    };
  }

  async listProtocols(): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("ListProtocols", {});
    }
    const status = await this.clusterStatus();
    return {
      rap: "ListProtocolsResponse",
      payload: {
        protocols: status.payload.protocols ?? [],
      },
    };
  }

  async listAgents(args: ListAgentsArgs = {}): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("ListAgents", { ...args });
    }

    const store = await this.getStateStore();
    let agents = (await store.list(AGENTS_PREFIX)).map((entry) => decodeJson<AgentRegistration>(entry.value));
    if (args.role) agents = agents.filter((agent) => agent.role === args.role);
    if (args.status) agents = agents.filter((agent) => agent.lifecycle === args.status);
    if (args.filter) {
      const filter = args.filter.toLowerCase();
      agents = agents.filter((agent) =>
        agent.name.toLowerCase().includes(filter) ||
        agent.role.toLowerCase().includes(filter),
      );
    }
    const offset = args.offset ?? 0;
    const limit = args.limit ?? agents.length;
    const page = agents.slice(offset, offset + limit);

    return {
      rap: "ListAgentsResponse",
      payload: {
        agents: page,
        total: agents.length,
      },
    };
  }

  async stopAgent(agentName: string): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("StopAgent", { agentName });
    }
    const resolver = await this.getResolver();
    const { endpoint, nodeId } = await resolver.resolveAgent(agentName);
    const client = new NodeControlClient(endpoint.url);
    const payload = await client.request("StopAgent", { agentName });
    client.close();
    return {
      rap: "StopAgentSuccess",
      payload: {
        nodeId,
        ...payload,
      },
    };
  }

  async getDeployedIR(protocolName?: string): Promise<AdminResponse> {
    if (!this.stateStoreProvider) {
      return this.send("GetDeployedIR", { protocolName });
    }
    const nodes = await this.listNodeRegistrations();
    const results: Array<Record<string, unknown>> = [];
    for (const node of nodes) {
      if (!node.control?.url) continue;
      const client = new NodeControlClient(node.control.url);
      try {
        const payload = await client.request("GetDeployedIR", { protocolName });
        results.push({ nodeId: node.nodeId, ...payload });
      } catch {
        // ignore unavailable nodes
      } finally {
        client.close();
      }
    }
    return {
      rap: "GetDeployedIRResponse",
      payload: {
        nodes: results,
      },
    };
  }

  async setBreakpoints(sessionId: string, breakpoints: unknown[]): Promise<AdminResponse> {
    return this.send("SetBreakpointsRequest", { sessionId, breakpoints });
  }

  async debugCommand(sessionId: string, command: string, extra: Record<string, unknown> = {}): Promise<AdminResponse> {
    return this.send("DebugCommand", { sessionId, command, ...extra });
  }

  static fromStateStoreConfig(config: { kind: "memory" } | { kind: "etcd"; hosts: string[] }): AdminClient {
    const provider = new DirectStateStoreProvider(config);
    return new AdminClient({ stateStoreProvider: provider });
  }

  private async getStateStore(): Promise<StateStore> {
    if (!this.stateStoreProvider) {
      throw new Error("AdminClient is not configured with a StateStoreProvider");
    }
    if (!this.stateStorePromise) {
      this.stateStorePromise = this.stateStoreProvider.getStateStore();
    }
    return await this.stateStorePromise;
  }

  private async getResolver(): Promise<NodeEndpointResolver> {
    if (this.providedResolver) return this.providedResolver;
    if (!this.resolverPromise) {
      this.resolverPromise = this.getStateStore().then((store) => new StoreBackedNodeEndpointResolver(store));
    }
    return await this.resolverPromise;
  }

  private async listNodeRegistrations(): Promise<NodeRegistration[]> {
    const store = await this.getStateStore();
    const entries = await store.list(NODES_PREFIX);
    return entries.map((entry) => decodeJson<NodeRegistration>(entry.value));
  }
}
