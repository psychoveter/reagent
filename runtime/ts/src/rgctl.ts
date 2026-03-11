#!/usr/bin/env node

import { AdminClient } from "./admin/client.js";

type Command = "trigger" | "inspect-node" | "cluster-status" | "list-agents" | "list-protocols" | "stop-agent";

type ParsedArgs = {
  adminUrl?: string;
  stateStore: { kind: "memory" } | { kind: "etcd"; hosts: string[] };
  command: Command;
  agentName?: string;
  protocolName?: string;
  nodeId?: string;
  input?: Record<string, unknown>;
  role?: string;
  status?: string;
  filter?: string;
  limit?: number;
  offset?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  let adminUrl: string | undefined;
  let stateStore: ParsedArgs["stateStore"] = { kind: "etcd", hosts: ["http://127.0.0.1:2379"] };
  let command: Command | undefined;
  let agentName: string | undefined;
  let protocolName: string | undefined;
  let nodeId: string | undefined;
  let input: Record<string, unknown> | undefined;
  let role: string | undefined;
  let status: string | undefined;
  let filter: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "trigger" || arg === "inspect-node" || arg === "cluster-status" || arg === "list-agents" || arg === "list-protocols" || arg === "stop-agent") && !command) {
      command = arg;
    } else if (arg === "--admin-url" && argv[i + 1]) {
      adminUrl = argv[++i];
    } else if (arg === "--etcd-hosts" && argv[i + 1]) {
      stateStore = { kind: "etcd", hosts: argv[++i].split(",").map((part) => part.trim()).filter(Boolean) };
    } else if (arg === "--state-store" && argv[i + 1] === "memory") {
      ++i;
      stateStore = { kind: "memory" };
    } else if (arg === "--agent" && argv[i + 1]) {
      agentName = argv[++i];
    } else if (arg === "--protocol" && argv[i + 1]) {
      protocolName = argv[++i];
    } else if (arg === "--node" && argv[i + 1]) {
      nodeId = argv[++i];
    } else if (arg === "--input" && argv[i + 1]) {
      input = JSON.parse(argv[++i]) as Record<string, unknown>;
    } else if (arg === "--role" && argv[i + 1]) {
      role = argv[++i];
    } else if (arg === "--status" && argv[i + 1]) {
      status = argv[++i];
    } else if (arg === "--filter" && argv[i + 1]) {
      filter = argv[++i];
    } else if (arg === "--limit" && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (arg === "--offset" && argv[i + 1]) {
      offset = Number(argv[++i]);
    }
  }

  if (!command) {
    throw new Error("Usage: reagent-rgctl [--etcd-hosts http://127.0.0.1:2379] [--state-store memory] [--admin-url ws://127.0.0.1:18789] <trigger|inspect-node|cluster-status|list-agents|list-protocols|stop-agent> [options]");
  }

  return { adminUrl, stateStore, command, agentName, protocolName, nodeId, input, role, status, filter, limit, offset };
}

async function runCommand(client: AdminClient, args: ParsedArgs) {
  switch (args.command) {
    case "trigger":
      if (!args.agentName || !args.protocolName) {
        throw new Error("trigger requires --agent and --protocol");
      }
      return client.triggerProtocol({
        agentName: args.agentName,
        protocolName: args.protocolName,
        input: args.input ?? {},
      });
    case "inspect-node":
      if (!args.nodeId) {
        throw new Error("inspect-node requires --node");
      }
      return client.inspectNode(args.nodeId);
    case "cluster-status":
      return client.clusterStatus();
    case "list-agents":
      return client.listAgents({
        role: args.role,
        protocolName: args.protocolName,
        status: args.status,
        filter: args.filter,
        limit: args.limit,
        offset: args.offset,
      });
    case "list-protocols":
      return client.listProtocols();
    case "stop-agent":
      if (!args.agentName) {
        throw new Error("stop-agent requires --agent");
      }
      return client.stopAgent(args.agentName);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = args.adminUrl
    ? new AdminClient({ legacyAdminUrl: args.adminUrl })
    : AdminClient.fromStateStoreConfig(args.stateStore);
  const response = await runCommand(client, args);
  const result = {
    rap: response.rap,
    ...response.payload,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[rgctl] ${String(err)}\n`);
  process.exit(1);
});
