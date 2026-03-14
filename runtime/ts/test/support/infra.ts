import assert from "node:assert/strict";
import { createConnection } from "node:net";

import { EtcdStateStore } from "../../src/cluster/etcd-state-store.js";

export const DEFAULT_ETCD_HOSTS = (process.env.ETCD_HOSTS ?? "http://127.0.0.1:2379").split(",");
export const DEFAULT_NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function etcdReachable(hosts: readonly string[] = DEFAULT_ETCD_HOSTS): Promise<boolean> {
  try {
    const store = new EtcdStateStore({ hosts: [...hosts] });
    await store.get("/__probe__");
    await store.close();
    return true;
  } catch {
    return false;
  }
}

export async function natsReachable(url = DEFAULT_NATS_URL): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "127.0.0.1";
    const port = parsed.port ? Number(parsed.port) : 4222;
    await withTimeout(new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port });
      socket.setTimeout(1_500);
      socket.once("connect", () => {
        // A real NATS server sends an INFO line immediately after accept.
        socket.once("data", (chunk) => {
          const text = chunk.toString("utf8");
          socket.end();
          socket.destroy();
          if (text.startsWith("INFO ")) {
            resolve();
            return;
          }
          reject(new Error(`Unexpected NATS handshake: ${JSON.stringify(text.slice(0, 32))}`));
        });
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error("NATS TCP probe timed out waiting for INFO"));
      });
      socket.once("error", (error) => {
        socket.destroy();
        reject(error);
      });
    }), 2_500, "NATS TCP probe");
    return true;
  } catch {
    return false;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  check: () => Promise<boolean> | boolean,
  message: string,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  assert.fail(message);
}
