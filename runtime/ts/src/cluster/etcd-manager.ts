/**
 * EtcdManager — download, cache, start/stop etcd as a managed child process.
 *
 * Binary is cached under {cwd}/.reagent/etcd/{version}/ by default,
 * overridable via REAGENT_ETCD_DIR env var.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { platform, arch } from "node:os";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
const DEFAULT_VERSION = "3.6.8";
const DOWNLOAD_BASE = "https://storage.googleapis.com/etcd";

export interface EtcdManagerConfig {
  version?: string;
  /** Override binary cache directory. Default: {cwd}/.reagent/etcd/{version}/ */
  cacheDir?: string;
  /** etcd data directory. Default: {cacheDir}/data-{nodeId} */
  dataDir?: string;
  /** Node identity for naming the etcd member. */
  nodeId: string;
  /** Client listen port. Default: 2379 */
  clientPort?: number;
  /** Peer listen port. Default: 2380 */
  peerPort?: number;
  /** Peer URLs for cluster mode, e.g. ["node-1=http://host1:2380","node-2=http://host2:2380"] */
  initialCluster?: string[];
  /** "new" for first bootstrap, "existing" for joining. Default: "new" */
  initialClusterState?: "new" | "existing";
  /** Advertise client URL (default: http://127.0.0.1:{clientPort}) */
  advertiseClientUrl?: string;
  /** Advertise peer URL (default: http://127.0.0.1:{peerPort}) */
  advertisePeerUrl?: string;
}

function detectPlatform(): { os: string; archStr: string; ext: string } {
  const p = platform();
  const a = arch();
  const os = p === "darwin" ? "darwin" : "linux";
  const archStr = a === "arm64" ? "arm64" : "amd64";
  const ext = p === "darwin" ? "zip" : "tar.gz";
  return { os, archStr, ext };
}

function downloadUrl(version: string): string {
  const { os, archStr, ext } = detectPlatform();
  return `${DOWNLOAD_BASE}/v${version}/etcd-v${version}-${os}-${archStr}.${ext}`;
}

function defaultCacheDir(version: string): string {
  const envDir = process.env.REAGENT_ETCD_DIR;
  if (envDir) return join(envDir, version);
  return join(process.cwd(), ".reagent", "etcd", version);
}

async function httpDownload(url: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? httpsGet : httpGet;
    getter(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error("Redirect without Location header"));
        httpDownload(location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      resolve(res as unknown as Readable);
    }).on("error", reject);
  });
}

export class EtcdManager {
  readonly version: string;
  readonly cacheDir: string;
  readonly nodeId: string;
  readonly clientPort: number;
  readonly peerPort: number;
  private dataDir: string;
  private process: ChildProcess | null = null;
  private initialCluster: string[] | undefined;
  private initialClusterState: "new" | "existing";
  private advertiseClientUrl: string;
  private advertisePeerUrl: string;

  constructor(config: EtcdManagerConfig) {
    this.version = config.version ?? DEFAULT_VERSION;
    this.nodeId = config.nodeId;
    this.clientPort = config.clientPort ?? 2379;
    this.peerPort = config.peerPort ?? 2380;
    this.cacheDir = config.cacheDir ?? defaultCacheDir(this.version);
    this.dataDir = config.dataDir ?? join(this.cacheDir, `data-${this.nodeId}`);
    this.initialCluster = config.initialCluster;
    this.initialClusterState = config.initialClusterState ?? "new";
    this.advertiseClientUrl = config.advertiseClientUrl ?? `http://127.0.0.1:${this.clientPort}`;
    this.advertisePeerUrl = config.advertisePeerUrl ?? `http://127.0.0.1:${this.peerPort}`;
  }

  get clientUrl(): string {
    return `http://127.0.0.1:${this.clientPort}`;
  }

  get binaryPath(): string {
    return join(this.cacheDir, "etcd");
  }

  async ensureBinary(): Promise<string> {
    const binPath = this.binaryPath;
    if (existsSync(binPath)) return binPath;

    mkdirSync(this.cacheDir, { recursive: true });

    const url = downloadUrl(this.version);
    const { ext } = detectPlatform();
    console.log(`[etcd-manager] Downloading etcd v${this.version} from ${url}`);

    const stream = await httpDownload(url);

    if (ext === "tar.gz") {
      await this.extractTarGz(stream);
    } else {
      await this.extractZip(stream, url);
    }

    if (!existsSync(binPath)) {
      throw new Error(`etcd binary not found at ${binPath} after extraction`);
    }

    chmodSync(binPath, 0o755);
    console.log(`[etcd-manager] etcd v${this.version} cached at ${binPath}`);
    return binPath;
  }

  private async extractTarGz(stream: Readable): Promise<void> {
    const { os, archStr } = detectPlatform();
    const prefix = `etcd-v${this.version}-${os}-${archStr}`;

    // node:tar extract doesn't exist as a named export; use tar.x or pipeline + gunzip
    // We'll use a simpler approach: pipe through gunzip, then use tar module
    const tmpDir = join(this.cacheDir, "_tmp_extract");
    mkdirSync(tmpDir, { recursive: true });

    const tarFile = join(tmpDir, "etcd.tar");
    const gunzip = createGunzip();

    // First decompress .gz to .tar
    const tarStream = createWriteStream(tarFile);
    await pipeline(stream, gunzip, tarStream);

    // Now extract tar using child_process tar (universally available)
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("tar", ["xf", tarFile, "-C", tmpDir], { stdio: "pipe" });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extract exited with code ${code}`));
      });
      proc.on("error", reject);
    });

    // Move binaries up
    const extractedDir = join(tmpDir, prefix);
    for (const name of ["etcd", "etcdctl", "etcdutl"]) {
      const src = join(extractedDir, name);
      const dst = join(this.cacheDir, name);
      if (existsSync(src)) {
        await rename(src, dst);
      }
    }

    await rm(tmpDir, { recursive: true, force: true });
  }

  private async extractZip(stream: Readable, url: string): Promise<void> {
    // For macOS zip: download to temp, use system unzip
    const tmpDir = join(this.cacheDir, "_tmp_extract");
    mkdirSync(tmpDir, { recursive: true });

    const zipFile = join(tmpDir, "etcd.zip");
    const zipStream = createWriteStream(zipFile);
    await pipeline(stream, zipStream);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("unzip", ["-o", zipFile, "-d", tmpDir], { stdio: "pipe" });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`unzip exited with code ${code}`));
      });
      proc.on("error", reject);
    });

    const { os, archStr } = detectPlatform();
    const prefix = `etcd-v${this.version}-${os}-${archStr}`;
    const extractedDir = join(tmpDir, prefix);

    for (const name of ["etcd", "etcdctl", "etcdutl"]) {
      const src = join(extractedDir, name);
      const dst = join(this.cacheDir, name);
      if (existsSync(src)) {
        await rename(src, dst);
      }
    }

    await rm(tmpDir, { recursive: true, force: true });
  }

  async start(): Promise<void> {
    if (this.process) return;

    const binPath = await this.ensureBinary();
    mkdirSync(this.dataDir, { recursive: true });

    const args = [
      "--name", this.nodeId,
      "--data-dir", this.dataDir,
      "--listen-client-urls", `http://127.0.0.1:${this.clientPort}`,
      "--advertise-client-urls", this.advertiseClientUrl,
      "--listen-peer-urls", `http://127.0.0.1:${this.peerPort}`,
      "--initial-advertise-peer-urls", this.advertisePeerUrl,
    ];

    if (this.initialCluster && this.initialCluster.length > 0) {
      args.push("--initial-cluster", this.initialCluster.join(","));
    } else {
      args.push("--initial-cluster", `${this.nodeId}=${this.advertisePeerUrl}`);
    }

    args.push("--initial-cluster-state", this.initialClusterState);

    this.process = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[etcd] ${line}`);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[etcd] ${line}`);
    });

    this.process.on("exit", (code, signal) => {
      console.log(`[etcd-manager] etcd exited: code=${code} signal=${signal}`);
      this.process = null;
    });

    await this.waitForHealthy(15_000);
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 5_000);

      proc.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      proc.kill("SIGTERM");
    });
  }

  get running(): boolean {
    return this.process !== null && !this.process.killed;
  }

  async waitForHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `${this.clientUrl}/health`;

    while (Date.now() < deadline) {
      try {
        const ok = await this.checkHealth(healthUrl);
        if (ok) return;
      } catch { /* retry */ }
      await sleep(300);
    }

    throw new Error(`etcd did not become healthy within ${timeoutMs}ms`);
  }

  private checkHealth(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const getter = url.startsWith("https") ? httpsGet : httpGet;
      const req = getter(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          resolve(res.statusCode === 200 && body.includes("true"));
        });
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
