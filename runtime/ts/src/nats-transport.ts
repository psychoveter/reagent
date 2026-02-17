/**
 * NATS Transport — wraps nats.js connection with Reagent subject conventions.
 */

import {
  connect,
  type NatsConnection,
  type Subscription,
  StringCodec,
} from "nats";

const sc = StringCodec();

export class NatsTransport {
  private nc: NatsConnection | null = null;
  private subs: Subscription[] = [];

  constructor(private natsUrl: string) {}

  async connect(): Promise<void> {
    this.nc = await connect({ servers: this.natsUrl });
  }

  async close(): Promise<void> {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    this.subs = [];
    if (this.nc && !this.nc.isClosed()) {
      try {
        await this.nc.close();
      } catch {
        // Connection may already be closed
      }
    }
    this.nc = null;
  }

  publish(subject: string, data: unknown): void {
    if (!this.nc) throw new Error("Not connected");
    this.nc.publish(subject, sc.encode(JSON.stringify(data)));
  }

  subscribe(subject: string, handler: (data: unknown, subject: string) => void): Subscription {
    if (!this.nc) throw new Error("Not connected");
    const sub = this.nc.subscribe(subject);
    this.subs.push(sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const parsed = JSON.parse(sc.decode(msg.data));
          handler(parsed, msg.subject);
        } catch (err) {
          console.error(`[nats-transport] Failed to parse message on ${msg.subject}:`, err);
        }
      }
    })();

    return sub;
  }

  get connection(): NatsConnection {
    if (!this.nc) throw new Error("Not connected");
    return this.nc;
  }
}
