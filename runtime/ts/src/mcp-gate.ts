#!/usr/bin/env node
/**
 * mcp-gate — standalone MCP server subprocess for Reagent protocol participation.
 *
 * Usage:
 *   node mcp-gate.js --ros-url ws://localhost:7400 --node-id my-agent \
 *     --nats-url nats://localhost:4222 --etcd-hosts http://127.0.0.1:2379
 *
 * This process:
 *   1. Bootstraps cluster (connects to etcd for agent discovery)
 *   2. Connects to ROS via WebSocket (receives deploy/trigger commands)
 *   3. Uses CustomAgentNode + McpAgentAdapter (zones go to MCP client)
 *   4. Creates NatsNodeLinks lazily when remote agents are discovered via etcd
 *   5. Exposes Reagent MCP tools on stdio (JSON-RPC via stdin/stdout)
 *
 * The agent (Claude Code, Cursor) starts this process as an MCP server subprocess:
 *   { "command": "node", "args": ["mcp-gate.js", "--ros-url", "ws://...", "--node-id", "claude-1", ...] }
 */

import { WebSocket } from "ws";
import { ReagentController } from "./reagent-controller.js";
import { CustomAgentNode } from "./custom-agent-node.js";
import { McpAgentAdapter } from "./mcp-agent-adapter.js";
import { ReagentMcpServer } from "./mcp-server.js";
import { NatsNodeLink } from "./nats-node-link.js";
import { EtcdMembership } from "./etcd-membership.js";
import { EtcdStateStore } from "./etcd-state-store.js";
import { LeaderElection } from "./leader-election.js";
import type { IRGraph, RoleIR, MessageEnvelope } from "./types.js";

// ── CLI args ─────────────────────────────────────────────────────────

interface GateArgs {
  rosUrl: string;
  nodeId: string;
  langs: string[];
  natsUrl: string;
  etcdHosts: string[];
  requestedAgents: string[];
}

function parseArgs(): GateArgs {
  const args = process.argv.slice(2);
  let rosUrl = "ws://localhost:7400";
  let nodeId = `mcp-gate-${process.pid}`;
  let langs = ["ts"];
  let natsUrl = "nats://localhost:4222";
  let etcdHosts = ["http://127.0.0.1:2379"];
  let requestedAgents: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ros-url" && args[i + 1]) rosUrl = args[++i];
    else if (args[i] === "--node-id" && args[i + 1]) nodeId = args[++i];
    else if (args[i] === "--langs" && args[i + 1]) langs = args[++i].split(",");
    else if (args[i] === "--nats-url" && args[i + 1]) natsUrl = args[++i];
    else if (args[i] === "--etcd-hosts" && args[i + 1]) etcdHosts = args[++i].split(",");
    else if (args[i] === "--agents" && args[i + 1]) requestedAgents = args[++i].split(",").map(s => s.trim());
  }

  return { rosUrl, nodeId, langs, natsUrl, etcdHosts, requestedAgents };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { rosUrl, nodeId, langs, natsUrl, etcdHosts, requestedAgents } = parseArgs();

  const log = (msg: string) => process.stderr.write(`[mcp-gate ${nodeId}] ${msg}\n`);

  // ── Cluster: connect to shared etcd ──

  const stateStore = new EtcdStateStore({ hosts: etcdHosts });
  log(`Connected to etcd at ${etcdHosts.join(",")}`);

  const cronLeaderElection = new LeaderElection({
    stateStore,
    leaderKey: "/cron/leader",
    candidateId: nodeId,
  });

  // ── RC setup ──

  const adapter = new McpAgentAdapter(nodeId);
  const roleToAgent: Record<string, string> = {};

  const mcpNode = new CustomAgentNode({
    roleToAgent,
    agentFactory: () => adapter,
  });

  const agentNodes: Record<string, typeof mcpNode> = {};
  for (const lang of langs) agentNodes[lang] = mcpNode;

  const rc = new ReagentController({
    nodeId,
    agentNodes,
    stateStore,
    cronLeaderElection,
  });

  // ── Etcd membership with lazy NatsNodeLink creation ──

  const createdLinks = new Map<string, NatsNodeLink>();

  const ensureLink = async (remoteNodeId: string): Promise<void> => {
    if (createdLinks.has(remoteNodeId)) return;
    const link = new NatsNodeLink({ localNodeId: nodeId, remoteNodeId, natsUrl });
    await link.connect();
    rc.addNodeLink(link);
    createdLinks.set(remoteNodeId, link);
    log(`NatsNodeLink created for remote node: ${remoteNodeId}`);
  };

  const membership = new EtcdMembership({
    stateStore,
    nodeId,
    onRemoteAgent: async (agentName, remoteNodeId) => {
      try {
        await ensureLink(remoteNodeId);
        rc.registerRemoteAgent(agentName, remoteNodeId);
        log(`Discovered remote agent: ${agentName} on ${remoteNodeId}`);
      } catch (err) {
        log(`Failed to set up link for ${remoteNodeId}: ${err}`);
      }
    },
    onRemoteAgentRemoved: (agentName) => {
      log(`Remote agent removed: ${agentName}`);
    },
    onNodeJoin: (nid) => {
      log(`Node joined: ${nid}`);
    },
    onNodeLeave: async (nid) => {
      log(`Node left: ${nid}`);
      const link = createdLinks.get(nid);
      if (link) {
        await link.close();
        createdLinks.delete(nid);
      }
    },
  });

  await membership.start();
  log("Etcd membership started");

  // ── Connect to ROS ──

  const ws = new WebSocket(rosUrl);

  const sendControl = (rap: string, payload: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ rap, payload, nodeId }));
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({
        rap: "Register",
        payload: { nodeId, supportedLangs: langs, requestedAgents },
      }));

      ws.on("message", (data) => {
        const raw = data.toString();
        try {
          const msg = JSON.parse(raw);
          if (msg.rap) {
            handleControlMessage(msg);
          } else if (msg.from && msg.to) {
            rc.getAgent(msg.to.agent)?.dispatchMessage(msg as MessageEnvelope);
          }
        } catch { /* ignore */ }
      });

      resolve();
    });
    ws.on("error", reject);
  });

  log(`Connected to ROS at ${rosUrl}`);

  function handleControlMessage(msg: { rap: string; id?: string; payload?: Record<string, unknown> }): void {
    switch (msg.rap) {
      case "Accepted":
        log("Registered with ROS");
        break;
      case "Rejected":
        log(`Registration rejected: ${msg.payload?.reason}`);
        break;
      case "Deploy":
        handleDeploy(msg.payload ?? {});
        break;
      case "TriggerProtocol":
        handleTrigger(msg.payload ?? {});
        break;
      case "NodeInspect":
        handleNodeInspect(msg.id);
        break;
    }
  }

  function handleNodeInspect(requestId?: string): void {
    const agents = [...rc.getRegisteredAgents()].map(([name, handle]) => ({
      name,
      lang: "ts",
      route: `local (${nodeId})`,
    }));

    const protocols: Array<{ name: string; version: string; agents: string[]; graphs: string[] }> = [];
    const seenProtos = new Set<string>();
    for (const [agentName, handle] of rc.getRegisteredAgents()) {
      const graphs = (handle as any).graphs as Map<string, unknown> | undefined;
      if (graphs) {
        for (const key of graphs.keys()) {
          const parts = key.split(".");
          const protoName = parts[0];
          if (!seenProtos.has(protoName)) {
            seenProtos.add(protoName);
            protocols.push({ name: protoName, version: "1.0", agents: [agentName], graphs: [key] });
          }
        }
      }
    }

    const routing: Record<string, string> = { ...roleToAgent };

    sendControl("NodeInspectResult", {
      requestId,
      nodeId,
      agents,
      protocols,
      routing,
      agentNodes: [nodeId],
    });
  }

  function handleDeploy(payload: Record<string, unknown>): void {
    const agentName = payload.agentName as string;
    const roleIR = payload.roleIR as unknown as RoleIR;
    const graphs = new Map<string, IRGraph>();

    const graphsObj = payload.graphs as Record<string, unknown> | undefined;
    if (graphsObj) {
      for (const [key, graph] of Object.entries(graphsObj)) {
        graphs.set(key, graph as IRGraph);
      }
    }

    const rta = payload.roleToAgent as Record<string, string> | undefined;
    if (rta) Object.assign(roleToAgent, rta);

    rc.registerAgent(agentName, roleIR, graphs);
    sendControl("Deployed", { agentName, nodeId });
    log(`Deployed agent: ${agentName}`);
  }

  function handleTrigger(payload: Record<string, unknown>): void {
    const agentName = payload.agentName as string;
    const instanceId = payload.instanceId as string;
    const protocolName = payload.protocolName as string;
    const input = (payload.input as Record<string, unknown>) ?? {};
    const rta = (payload.roleToAgent as Record<string, string>) ?? roleToAgent;

    rc.triggerProtocol(agentName, { instanceId, protocolName, input, roleToAgent: rta });
    log(`Triggered: ${protocolName} instance=${instanceId} agent=${agentName}`);
  }

  // ── Start MCP server on stdio ──

  const mcpServer = new ReagentMcpServer({
    adapter,
    onInvoke: async (protocolName, input, roleBindings) => {
      const instanceId = `${protocolName}-${Date.now()}`;
      sendControl("InvokeRequest", { protocolName, input, roleBindings, instanceId });
      return instanceId;
    },
  });

  await mcpServer.startStdio();
  log("MCP stdio server running");

  // ── Graceful shutdown ──

  const shutdown = async () => {
    await mcpServer.close();
    await membership.stop();
    for (const link of createdLinks.values()) {
      await link.close();
    }
    await cronLeaderElection.stop();
    await rc.stop();
    await stateStore.close();
    ws.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[mcp-gate] Fatal: ${err}\n`);
  process.exit(1);
});
