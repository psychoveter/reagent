/**
 * SWIM-like gossip discovery agent.
 *
 * Maintains a membership list of known nodes and their agent inventories.
 * Periodically pings random peers; escalates non-responders via indirect ping.
 * Membership changes are disseminated by piggybacking on all gossip messages.
 */

export interface MemberEntry {
  nodeId: string;
  status: "alive" | "suspect" | "dead";
  incarnation: number;
  agents: string[];
  lastSeen: number;
}

export interface DiscoveryConfig {
  nodeId: string;
  /** Interval between probe rounds in ms. Default 1000. */
  probeIntervalMs?: number;
  /** Timeout waiting for direct Ack in ms. Default 500. */
  probeTimeoutMs?: number;
  /** Number of indirect-ping relays (SWIM k parameter). Default 3. */
  indirectRelays?: number;
  /** How many rounds without response before marking suspect. Default 3. */
  suspectRounds?: number;
  /** How many rounds as suspect before marking dead. Default 5. */
  deadRounds?: number;
  /** Seed peers to bootstrap from. */
  seeds?: string[];
  /** Transport send function — provided by the RC or adapter. */
  send?: (targetNodeId: string, message: GossipMessage) => void;
}

export type GossipMessageType =
  | "ping"
  | "ack"
  | "ping-req"
  | "indirect-ping"
  | "indirect-ack"
  | "ping-req-ack"
  | "membership-change"
  | "membership-ack";

export interface GossipMessage {
  type: GossipMessageType;
  senderId: string;
  targetId?: string;
  incarnation: number;
  payload: Record<string, unknown>;
  membershipUpdates?: MembershipDelta[];
}

export interface MembershipDelta {
  nodeId: string;
  status: "alive" | "suspect" | "dead" | "join";
  incarnation: number;
  agents: string[];
  timestamp: number;
}

export class DiscoveryAgent {
  readonly nodeId: string;
  private members = new Map<string, MemberEntry>();
  private pendingDeltas: MembershipDelta[] = [];
  private incarnation = 0;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = new Map<string, number>();
  private config: Required<
    Pick<DiscoveryConfig, "probeIntervalMs" | "probeTimeoutMs" | "indirectRelays" | "suspectRounds" | "deadRounds">
  > & DiscoveryConfig;

  constructor(config: DiscoveryConfig) {
    this.nodeId = config.nodeId;
    this.config = {
      probeIntervalMs: 1000,
      probeTimeoutMs: 500,
      indirectRelays: 3,
      suspectRounds: 3,
      deadRounds: 5,
      ...config,
    };

    this.members.set(this.nodeId, {
      nodeId: this.nodeId,
      status: "alive",
      incarnation: this.incarnation,
      agents: [],
      lastSeen: Date.now(),
    });

    for (const seed of config.seeds ?? []) {
      if (seed !== this.nodeId) {
        this.members.set(seed, {
          nodeId: seed,
          status: "alive",
          incarnation: 0,
          agents: [],
          lastSeen: Date.now(),
        });
      }
    }
  }

  start(): void {
    this.probeTimer = setInterval(() => this.probeRound(), this.config.probeIntervalMs);
  }

  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  getMembers(): Map<string, MemberEntry> {
    return new Map(this.members);
  }

  getAliveNodes(): string[] {
    return [...this.members.values()]
      .filter((m) => m.status === "alive")
      .map((m) => m.nodeId);
  }

  /** Build a routing table: agentName → nodeId for all alive nodes. */
  getRoutingTable(): Map<string, string> {
    const table = new Map<string, string>();
    for (const member of this.members.values()) {
      if (member.status !== "alive") continue;
      for (const agent of member.agents) {
        table.set(agent, member.nodeId);
      }
    }
    return table;
  }

  /** Register local agents for this node. */
  setLocalAgents(agents: string[]): void {
    const entry = this.members.get(this.nodeId);
    if (entry) {
      entry.agents = agents;
      this.incarnation++;
      entry.incarnation = this.incarnation;
      this.enqueueDelta({
        nodeId: this.nodeId,
        status: "alive",
        incarnation: this.incarnation,
        agents,
        timestamp: Date.now(),
      });
    }
  }

  /** Handle an incoming gossip message from a peer. */
  handleMessage(msg: GossipMessage): void {
    if (msg.membershipUpdates) {
      for (const delta of msg.membershipUpdates) {
        this.applyDelta(delta);
      }
    }

    switch (msg.type) {
      case "ping":
        this.handlePing(msg);
        break;
      case "ack":
        this.handleAck(msg);
        break;
      case "ping-req":
        this.handlePingReq(msg);
        break;
      case "indirect-ack":
        this.handleIndirectAck(msg);
        break;
      case "ping-req-ack":
        this.handlePingReqAck(msg);
        break;
      case "membership-change":
        this.handleMembershipChange(msg);
        break;
      default:
        break;
    }
  }

  private probeRound(): void {
    const peers = [...this.members.values()].filter(
      (m) => m.nodeId !== this.nodeId && m.status !== "dead"
    );
    if (peers.length === 0) return;

    const target = peers[Math.floor(Math.random() * peers.length)];
    this.send(target.nodeId, {
      type: "ping",
      senderId: this.nodeId,
      targetId: target.nodeId,
      incarnation: this.incarnation,
      payload: {},
      membershipUpdates: this.drainDeltas(),
    });

    const missed = (this.missedPings.get(target.nodeId) ?? 0) + 1;
    this.missedPings.set(target.nodeId, missed);

    setTimeout(() => {
      const currentMissed = this.missedPings.get(target.nodeId) ?? 0;
      if (currentMissed >= missed) {
        this.handleProbeTimeout(target.nodeId);
      }
    }, this.config.probeTimeoutMs);
  }

  private handleProbeTimeout(targetId: string): void {
    const missed = this.missedPings.get(targetId) ?? 0;
    const entry = this.members.get(targetId);
    if (!entry) return;

    if (missed >= this.config.deadRounds && entry.status === "suspect") {
      entry.status = "dead";
      this.enqueueDelta({
        nodeId: targetId,
        status: "dead",
        incarnation: entry.incarnation,
        agents: entry.agents,
        timestamp: Date.now(),
      });
    } else if (missed >= this.config.suspectRounds && entry.status === "alive") {
      entry.status = "suspect";
      this.enqueueDelta({
        nodeId: targetId,
        status: "suspect",
        incarnation: entry.incarnation,
        agents: entry.agents,
        timestamp: Date.now(),
      });

      const relays = [...this.members.values()]
        .filter((m) => m.nodeId !== this.nodeId && m.nodeId !== targetId && m.status === "alive")
        .slice(0, this.config.indirectRelays);

      for (const relay of relays) {
        this.send(relay.nodeId, {
          type: "ping-req",
          senderId: this.nodeId,
          targetId,
          incarnation: this.incarnation,
          payload: { requesterId: this.nodeId },
          membershipUpdates: this.drainDeltas(),
        });
      }
    }
  }

  private handlePing(msg: GossipMessage): void {
    this.markAlive(msg.senderId, msg.incarnation);
    this.send(msg.senderId, {
      type: "ack",
      senderId: this.nodeId,
      targetId: msg.senderId,
      incarnation: this.incarnation,
      payload: {},
      membershipUpdates: this.drainDeltas(),
    });
  }

  private handleAck(msg: GossipMessage): void {
    this.markAlive(msg.senderId, msg.incarnation);
    this.missedPings.set(msg.senderId, 0);
  }

  private handlePingReq(msg: GossipMessage): void {
    const targetId = msg.targetId!;
    this.send(targetId, {
      type: "indirect-ping",
      senderId: this.nodeId,
      targetId,
      incarnation: this.incarnation,
      payload: { requesterId: msg.senderId, relayId: this.nodeId },
      membershipUpdates: this.drainDeltas(),
    });
  }

  private handleIndirectAck(msg: GossipMessage): void {
    const requesterId = msg.payload.requesterId as string;
    if (requesterId) {
      this.send(requesterId, {
        type: "ping-req-ack",
        senderId: this.nodeId,
        targetId: requesterId,
        incarnation: msg.incarnation,
        payload: { targetId: msg.senderId, alive: true },
      });
    }
  }

  private handlePingReqAck(msg: GossipMessage): void {
    const targetId = msg.payload.targetId as string;
    const alive = msg.payload.alive as boolean;
    if (alive && targetId) {
      this.markAlive(targetId, msg.incarnation);
      this.missedPings.set(targetId, 0);
    }
  }

  private handleMembershipChange(msg: GossipMessage): void {
    this.send(msg.senderId, {
      type: "membership-ack",
      senderId: this.nodeId,
      targetId: msg.senderId,
      incarnation: this.incarnation,
      payload: { accepted: true },
    });
  }

  private markAlive(nodeId: string, incarnation: number): void {
    const entry = this.members.get(nodeId);
    if (entry) {
      if (incarnation >= entry.incarnation) {
        entry.status = "alive";
        entry.incarnation = incarnation;
        entry.lastSeen = Date.now();
      }
    } else {
      this.members.set(nodeId, {
        nodeId,
        status: "alive",
        incarnation,
        agents: [],
        lastSeen: Date.now(),
      });
      this.enqueueDelta({
        nodeId,
        status: "join",
        incarnation,
        agents: [],
        timestamp: Date.now(),
      });
    }
  }

  private applyDelta(delta: MembershipDelta): void {
    const existing = this.members.get(delta.nodeId);
    if (existing) {
      if (delta.incarnation >= existing.incarnation) {
        existing.status = delta.status === "join" ? "alive" : delta.status;
        existing.incarnation = delta.incarnation;
        existing.agents = delta.agents.length > 0 ? delta.agents : existing.agents;
        existing.lastSeen = delta.timestamp;
      }
    } else if (delta.status !== "dead") {
      this.members.set(delta.nodeId, {
        nodeId: delta.nodeId,
        status: delta.status === "join" ? "alive" : delta.status,
        incarnation: delta.incarnation,
        agents: delta.agents,
        lastSeen: delta.timestamp,
      });
    }
  }

  private enqueueDelta(delta: MembershipDelta): void {
    this.pendingDeltas.push(delta);
    if (this.pendingDeltas.length > 100) {
      this.pendingDeltas = this.pendingDeltas.slice(-50);
    }
  }

  private drainDeltas(): MembershipDelta[] {
    const deltas = [...this.pendingDeltas];
    this.pendingDeltas = [];

    // Always piggyback full membership for dissemination (SWIM-style)
    if (deltas.length === 0) {
      for (const member of this.members.values()) {
        if (member.status === "dead") continue;
        deltas.push({
          nodeId: member.nodeId,
          status: member.status === "alive" ? "alive" : member.status,
          incarnation: member.incarnation,
          agents: member.agents,
          timestamp: member.lastSeen,
        });
      }
    }

    return deltas;
  }

  private send(targetNodeId: string, message: GossipMessage): void {
    if (this.config.send) {
      this.config.send(targetNodeId, message);
    }
  }
}
