/**
 * LeaderElection — lease-based leader election on top of StateStore.
 *
 * Uses putIfAbsent + lease: the first node to CAS-write the leader key wins.
 * On lease expiry (node crash), another node can acquire leadership.
 * The leader must call keepAlive periodically to maintain the lease.
 */

import type { StateStore, Lease } from "./state-store.js";

export interface LeaderElectionConfig {
  stateStore: StateStore;
  /** The key to compete for, e.g. "/cron/leader" */
  leaderKey: string;
  /** Identity of this candidate (typically nodeId) */
  candidateId: string;
  /** Lease TTL in seconds. Default: 10 */
  leaseTtlSeconds?: number;
  /** How often to attempt acquisition if not leader, in ms. Default: 5000 */
  retryIntervalMs?: number;
  /** How often to keepAlive the lease when leader, in ms. Default: leaseTtl / 3 */
  keepAliveIntervalMs?: number;
  /** Callback when this node becomes leader. */
  onElected?: () => void;
  /** Callback when this node loses leadership (lease lost). */
  onRevoked?: () => void;
}

export class LeaderElection {
  private store: StateStore;
  private leaderKey: string;
  private candidateId: string;
  private leaseTtlSeconds: number;
  private retryIntervalMs: number;
  private keepAliveIntervalMs: number;
  private onElected?: () => void;
  private onRevoked?: () => void;

  private lease: Lease | null = null;
  private _isLeader = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(config: LeaderElectionConfig) {
    this.store = config.stateStore;
    this.leaderKey = config.leaderKey;
    this.candidateId = config.candidateId;
    this.leaseTtlSeconds = config.leaseTtlSeconds ?? 10;
    this.retryIntervalMs = config.retryIntervalMs ?? 5000;
    this.keepAliveIntervalMs = config.keepAliveIntervalMs ?? Math.floor((this.leaseTtlSeconds * 1000) / 3);
    this.onElected = config.onElected;
    this.onRevoked = config.onRevoked;
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tryAcquire();

    this.timer = setInterval(() => {
      void this.loop();
    }, this._isLeader ? this.keepAliveIntervalMs : this.retryIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lease) {
      try {
        await this.lease.revoke();
      } catch { /* best effort */ }
      this.lease = null;
    }
    if (this._isLeader) {
      this._isLeader = false;
      this.onRevoked?.();
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;

    if (this._isLeader) {
      await this.keepAlive();
    } else {
      await this.tryAcquire();
    }

    // Adjust interval based on state
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(
        () => void this.loop(),
        this._isLeader ? this.keepAliveIntervalMs : this.retryIntervalMs,
      );
    }
  }

  private async tryAcquire(): Promise<void> {
    try {
      const lease = await this.store.createLease(this.leaseTtlSeconds);
      const acquired = await this.store.putIfAbsent(this.leaderKey, this.candidateId, { lease: lease.id });

      if (acquired) {
        this.lease = lease;
        this._isLeader = true;
        this.onElected?.();
      } else {
        await lease.revoke();
      }
    } catch (err) {
      console.warn(`[LeaderElection] Failed to acquire ${this.leaderKey}:`, err);
    }
  }

  private async keepAlive(): Promise<void> {
    if (!this.lease) return;
    try {
      await this.lease.keepAlive();
    } catch {
      this._isLeader = false;
      this.lease = null;
      this.onRevoked?.();
    }
  }
}
