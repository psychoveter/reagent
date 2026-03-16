/**
 * Tests for EtcdStateStore.
 *
 * Integration tests require etcd at localhost:2379.
 * Run:  docker run -d --name etcd-test -p 2379:2379 -p 2380:2380 \
 *         quay.io/coreos/etcd:v3.6.8 etcd \
 *         --advertise-client-urls http://0.0.0.0:2379 \
 *         --listen-client-urls http://0.0.0.0:2379
 *
 * Tests are skipped if etcd is unreachable.
 *
 * Run: npx tsx test/cluster/etcd-state-store.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { EtcdStateStore } from "../../src";
import { DEFAULT_ETCD_HOSTS, etcdReachable } from "../support/infra.js";

const ETCD_HOSTS = DEFAULT_ETCD_HOSTS;

describe("EtcdStateStore (integration)", () => {
  let available = false;
  let store: EtcdStateStore;

  const testPrefix = `/__test_${Date.now()}/`;

  before(async () => {
    available = await etcdReachable();
    if (!available) {
      console.log("  ⚠ etcd not reachable at", ETCD_HOSTS.join(","), "— skipping integration tests");
      return;
    }
    store = new EtcdStateStore({ hosts: ETCD_HOSTS });
  });

  after(async () => {
    if (!available) return;
    // Clean up all test keys
    const entries = await store.list(testPrefix);
    for (const entry of entries) {
      await store.delete(entry.key);
    }
    await store.close();
  });

  function key(name: string): string {
    return `${testPrefix}${name}`;
  }

  // ── get / put ─────────────────────────────────────────────────────

  it("put then get returns stored value", async (t) => {
    if (!available) { t.skip(); return; }
    await store.put(key("hello"), "world");
    const val = await store.get(key("hello"));
    assert.strictEqual(val, "world");
  });

  it("get returns null for missing key", async (t) => {
    if (!available) { t.skip(); return; }
    const val = await store.get(key("nonexistent"));
    assert.strictEqual(val, null);
  });

  it("put overwrites existing value", async (t) => {
    if (!available) { t.skip(); return; }
    await store.put(key("overwrite"), "v1");
    await store.put(key("overwrite"), "v2");
    const val = await store.get(key("overwrite"));
    assert.strictEqual(val, "v2");
  });

  // ── delete ────────────────────────────────────────────────────────

  it("delete returns true for existing key", async (t) => {
    if (!available) { t.skip(); return; }
    await store.put(key("del-me"), "x");
    const result = await store.delete(key("del-me"));
    assert.strictEqual(result, true);
    const val = await store.get(key("del-me"));
    assert.strictEqual(val, null);
  });

  it("delete returns false for missing key", async (t) => {
    if (!available) { t.skip(); return; }
    const result = await store.delete(key("never-existed"));
    assert.strictEqual(result, false);
  });

  // ── list ──────────────────────────────────────────────────────────

  it("list returns all entries under prefix, sorted", async (t) => {
    if (!available) { t.skip(); return; }
    await store.put(key("list/c"), "3");
    await store.put(key("list/a"), "1");
    await store.put(key("list/b"), "2");
    const entries = await store.list(key("list/"));
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].key, key("list/a"));
    assert.strictEqual(entries[0].value, "1");
    assert.strictEqual(entries[1].key, key("list/b"));
    assert.strictEqual(entries[2].key, key("list/c"));
  });

  it("list returns empty for unknown prefix", async (t) => {
    if (!available) { t.skip(); return; }
    const entries = await store.list(key("empty-prefix/"));
    assert.strictEqual(entries.length, 0);
  });

  // ── putIfAbsent ───────────────────────────────────────────────────

  it("putIfAbsent succeeds on new key", async (t) => {
    if (!available) { t.skip(); return; }
    const result = await store.putIfAbsent(key("cas-new"), "first");
    assert.strictEqual(result, true);
    const val = await store.get(key("cas-new"));
    assert.strictEqual(val, "first");
  });

  it("putIfAbsent fails on existing key", async (t) => {
    if (!available) { t.skip(); return; }
    await store.put(key("cas-exist"), "original");
    const result = await store.putIfAbsent(key("cas-exist"), "attempt");
    assert.strictEqual(result, false);
    const val = await store.get(key("cas-exist"));
    assert.strictEqual(val, "original");
  });

  // ── watch ─────────────────────────────────────────────────────────

  it("watch emits put events", async (t) => {
    if (!available) { t.skip(); return; }

    const events: WatchEvent[] = [];
    //@ts-ignore
    const watcher = store.watch(key("watch/"), (ev) => events.push(ev));

    // Give the watcher time to set up
    await sleep(500);

    await store.put(key("watch/x"), "hello");
    await sleep(500);

    assert.ok(events.length >= 1, `Expected at least 1 event, got ${events.length}`);
    const ev = events.find((e) => e.kind === "put" && e.key === key("watch/x"));
    assert.ok(ev, "Expected a put event for watch/x");
    assert.strictEqual(ev!.value, "hello");

    watcher.dispose();
  });

  it("watch emits delete events", async (t) => {
    if (!available) { t.skip(); return; }

    await store.put(key("watch-del/y"), "temp");

    const events: WatchEvent[] = [];
    // @ts-ignore
    const watcher = store.watch(key("watch-del/"), (ev) => events.push(ev));
    await sleep(500);

    await store.delete(key("watch-del/y"));
    await sleep(500);

    const ev = events.find((e) => e.kind === "delete" && e.key === key("watch-del/y"));
    assert.ok(ev, "Expected a delete event for watch-del/y");

    watcher.dispose();
  });

  // ── lease ─────────────────────────────────────────────────────────

  it("createLease returns a valid lease with keepAlive and revoke", async (t) => {
    if (!available) { t.skip(); return; }

    const lease = await store.createLease(10);
    assert.ok(lease.id, "Lease should have an id");

    await store.put(key("leased-key"), "val", { lease: lease.id });
    const val = await store.get(key("leased-key"));
    assert.strictEqual(val, "val");

    await lease.keepAlive();

    await lease.revoke();
    // After revoke, the key should be gone
    await sleep(200);
    const valAfter = await store.get(key("leased-key"));
    assert.strictEqual(valAfter, null);
  });

  it("lease expiry deletes associated keys", async (t) => {
    if (!available) { t.skip(); return; }

    const lease = await store.createLease(2); // 2-second TTL
    await store.put(key("expiry-key"), "ephemeral", { lease: lease.id });

    const val = await store.get(key("expiry-key"));
    assert.strictEqual(val, "ephemeral");

    // Wait for TTL expiry (2s + buffer)
    await sleep(4000);

    const valAfter = await store.get(key("expiry-key"));
    assert.strictEqual(valAfter, null);
  });

  // ── putIfAbsent with lease ────────────────────────────────────────

  it("putIfAbsent with lease attaches lease to key", async (t) => {
    if (!available) { t.skip(); return; }

    const lease = await store.createLease(2);
    const result = await store.putIfAbsent(key("cas-leased"), "leader", { lease: lease.id });
    assert.strictEqual(result, true);

    const val = await store.get(key("cas-leased"));
    assert.strictEqual(val, "leader");

    // Revoke → key should disappear
    await lease.revoke();
    await sleep(200);
    const valAfter = await store.get(key("cas-leased"));
    assert.strictEqual(valAfter, null);
  });
});

type WatchEvent = { kind: string; key: string; value?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
