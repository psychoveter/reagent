/**
 * Wave 3.2: Gossip discovery tests.
 *
 * Verifies that two DiscoveryAgent nodes can discover each other via gossip,
 * exchange membership, and detect failures.
 */

import { DiscoveryAgent } from "../ts/src/discovery-agent.js";
import type { GossipMessage } from "../ts/src/discovery-agent.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a pair of interconnected DiscoveryAgents with in-memory message routing.
 */
function createPair(): { a: DiscoveryAgent; b: DiscoveryAgent; messages: GossipMessage[] } {
  const messages: GossipMessage[] = [];
  const agents = new Map<string, DiscoveryAgent>();

  const route = (targetId: string, msg: GossipMessage) => {
    messages.push(msg);
    const target = agents.get(targetId);
    if (target) {
      setImmediate(() => target.handleMessage(msg));
    }
  };

  const a = new DiscoveryAgent({
    nodeId: "node-A",
    seeds: ["node-B"],
    probeIntervalMs: 50,
    probeTimeoutMs: 200,
    suspectRounds: 2,
    deadRounds: 4,
    send: route,
  });

  const b = new DiscoveryAgent({
    nodeId: "node-B",
    seeds: ["node-A"],
    probeIntervalMs: 50,
    probeTimeoutMs: 200,
    suspectRounds: 2,
    deadRounds: 4,
    send: route,
  });

  agents.set("node-A", a);
  agents.set("node-B", b);

  return { a, b, messages };
}

async function main(): Promise<void> {
  console.log("=== Wave 3.2: Gossip Discovery Tests ===\n");

  await run("GD1: Two nodes discover each other via gossip", async () => {
    const { a, b } = createPair();
    a.start();
    b.start();

    await sleep(300);

    const aMembers = a.getMembers();
    const bMembers = b.getMembers();

    a.stop();
    b.stop();

    if (!aMembers.has("node-B")) throw new Error("Node A doesn't know about Node B");
    if (!bMembers.has("node-A")) throw new Error("Node B doesn't know about Node A");

    const bInA = aMembers.get("node-B")!;
    if (bInA.status !== "alive") throw new Error(`Node B status in A: ${bInA.status}, expected alive`);
  });

  await run("GD2: Agent list exchange via membership deltas", async () => {
    const { a, b } = createPair();

    a.setLocalAgents(["BuyerAgent", "SellerAgent"]);
    b.setLocalAgents(["AuctioneerAgent"]);

    a.start();
    b.start();

    await sleep(400);

    a.stop();
    b.stop();

    const routingA = a.getRoutingTable();
    const routingB = b.getRoutingTable();

    if (!routingB.has("BuyerAgent")) throw new Error("Node B missing BuyerAgent route");
    if (!routingB.has("SellerAgent")) throw new Error("Node B missing SellerAgent route");
    if (routingB.get("BuyerAgent") !== "node-A") throw new Error("BuyerAgent should be on node-A");

    if (!routingA.has("AuctioneerAgent")) throw new Error("Node A missing AuctioneerAgent route");
    if (routingA.get("AuctioneerAgent") !== "node-B") throw new Error("AuctioneerAgent should be on node-B");
  });

  await run("GD3: getAliveNodes returns only alive peers", async () => {
    const { a, b } = createPair();
    a.start();
    b.start();

    await sleep(200);

    const alive = a.getAliveNodes();
    a.stop();
    b.stop();

    if (!alive.includes("node-A")) throw new Error("node-A should be in alive list");
    if (!alive.includes("node-B")) throw new Error("node-B should be in alive list");
  });

  await run("GD4: Gossip messages are exchanged", async () => {
    const { a, b, messages } = createPair();
    a.start();
    b.start();

    await sleep(200);

    a.stop();
    b.stop();

    if (messages.length === 0) throw new Error("No gossip messages were exchanged");

    const types = new Set(messages.map((m) => m.type));
    if (!types.has("ping")) throw new Error("No ping messages found");
    if (!types.has("ack")) throw new Error("No ack messages found");
  });

  await run("GD5: Failure detection — stopped node becomes suspect", async () => {
    const messages: GossipMessage[] = [];
    const agents = new Map<string, DiscoveryAgent>();

    const route = (targetId: string, msg: GossipMessage) => {
      messages.push(msg);
      const target = agents.get(targetId);
      if (target) {
        setImmediate(() => target.handleMessage(msg));
      }
    };

    const a = new DiscoveryAgent({
      nodeId: "node-A",
      seeds: ["node-B"],
      probeIntervalMs: 30,
      probeTimeoutMs: 80,
      suspectRounds: 2,
      deadRounds: 4,
      send: route,
    });

    const b = new DiscoveryAgent({
      nodeId: "node-B",
      seeds: ["node-A"],
      probeIntervalMs: 30,
      probeTimeoutMs: 80,
      suspectRounds: 2,
      deadRounds: 4,
      send: route,
    });

    agents.set("node-A", a);
    agents.set("node-B", b);

    a.start();
    b.start();
    await sleep(200);

    b.stop();
    agents.delete("node-B");

    await sleep(500);
    a.stop();

    const bEntry = a.getMembers().get("node-B");
    if (!bEntry) throw new Error("Node A should still have an entry for node-B");
    if (bEntry.status === "alive") throw new Error("Node B should not be alive after stopping — was: alive");
  });

  await run("GD6: Three-node gossip — transitive discovery", async () => {
    const agents = new Map<string, DiscoveryAgent>();

    const route = (targetId: string, msg: GossipMessage) => {
      const target = agents.get(targetId);
      if (target) {
        setImmediate(() => target.handleMessage(msg));
      }
    };

    const a = new DiscoveryAgent({
      nodeId: "node-A",
      seeds: ["node-B"],
      probeIntervalMs: 30,
      probeTimeoutMs: 100,
      suspectRounds: 3,
      deadRounds: 5,
      send: route,
    });
    const b = new DiscoveryAgent({
      nodeId: "node-B",
      seeds: ["node-A", "node-C"],
      probeIntervalMs: 30,
      probeTimeoutMs: 100,
      suspectRounds: 3,
      deadRounds: 5,
      send: route,
    });
    const c = new DiscoveryAgent({
      nodeId: "node-C",
      seeds: ["node-B"],
      probeIntervalMs: 30,
      probeTimeoutMs: 100,
      suspectRounds: 3,
      deadRounds: 5,
      send: route,
    });

    agents.set("node-A", a);
    agents.set("node-B", b);
    agents.set("node-C", c);

    a.start();
    b.start();
    c.start();

    await sleep(500);

    a.stop();
    b.stop();
    c.stop();

    const aMembers = a.getMembers();
    const cMembers = c.getMembers();

    if (!aMembers.has("node-C")) throw new Error("Node A should discover Node C transitively via B");
    if (!cMembers.has("node-A")) throw new Error("Node C should discover Node A transitively via B");
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
