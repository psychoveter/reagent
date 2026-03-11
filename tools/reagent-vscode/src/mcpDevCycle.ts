import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { ChildProcess, execSync } from 'child_process';
import type { ClusterPanelProvider } from './clusterPanel';
import { deployProject } from './deployController';

interface InfraStatus {
  nats: 'up' | 'down' | 'unknown';
  etcd: 'up' | 'down' | 'unknown';
  admin: 'up' | 'down' | 'unknown';
}

export class McpDevCycle implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private composeProcess: ChildProcess | null = null;
  private _infraStatus: InfraStatus = { nats: 'unknown', etcd: 'unknown', admin: 'unknown' };
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private _onStatusChange = new vscode.EventEmitter<InfraStatus>();
  readonly onStatusChange = this._onStatusChange.event;
  private statusBar: vscode.StatusBarItem;
  private _running = false;

  constructor(
    private readonly clusterPanel: ClusterPanelProvider,
    private readonly getCliPath: () => string,
  ) {
    this.outputChannel = vscode.window.createOutputChannel('Reagent MCP Dev');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    this.statusBar.command = 'reagent.stopMcpDevCycle';
    this.statusBar.hide();
  }

  get running(): boolean { return this._running; }
  get infraStatus(): InfraStatus { return { ...this._infraStatus }; }

  async start(): Promise<void> {
    if (this._running) {
      vscode.window.showWarningMessage('MCP Dev Cycle is already running');
      return;
    }

    this.outputChannel.clear();
    this.outputChannel.show(true);

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      vscode.window.showWarningMessage('Open a .rg file or reagent.json inside a Reagent project first');
      return;
    }

    this.log(`Project: ${projectRoot}`);
    this._running = true;
    this.updateStatusBar();
    this.statusBar.show();

    try {
      await this.startInfra(projectRoot);
      await this.compile(projectRoot);
      await this.connectAndDeploy(projectRoot);
      this.startHealthPolling();
      this.log('Ready — MCP gates connect automatically via .cursor/mcp.json');
      vscode.window.showInformationMessage('MCP Dev Cycle ready — infrastructure is up, project deployed');
    } catch (err) {
      this.log(`Failed: ${err}`);
      vscode.window.showErrorMessage(`MCP Dev Cycle failed: ${err}`);
      await this.stop();
    }
  }

  async stop(teardownInfra = false): Promise<void> {
    this.stopHealthPolling();

    if (this.composeProcess && !this.composeProcess.killed) {
      this.log('Stopping docker compose process handle...');
      this.composeProcess.kill('SIGTERM');
      this.composeProcess = null;
    }

    if (teardownInfra) {
      const projectRoot = this.findProjectRoot();
      if (projectRoot) {
        const composePath = this.findComposePath(projectRoot);
        if (composePath) {
          try {
            execSync('docker compose down', {
              cwd: path.dirname(composePath),
              timeout: 15000,
              stdio: 'pipe',
            });
            this.log('Docker compose stopped');
          } catch { /* best effort */ }
        }
      }
    } else {
      this.log('Keeping infrastructure running (NATS, etcd)');
    }

    this._running = false;
    this._infraStatus = { nats: 'unknown', etcd: 'unknown', admin: 'unknown' };
    this._onStatusChange.fire(this._infraStatus);
    this.updateStatusBar();
    this.statusBar.hide();
    this.log('MCP Dev Cycle stopped');
  }

  async recompileAndRedeploy(): Promise<void> {
    if (!this._running) {
      vscode.window.showWarningMessage('MCP Dev Cycle is not running');
      return;
    }

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) return;

    try {
      this.log('Recompiling...');
      await this.compile(projectRoot);
      this.log('Redeploying...');
      await deployProject(this.clusterPanel, projectRoot);
      this.log('Redeploy complete');
      vscode.window.showInformationMessage('Protocol recompiled and redeployed');
    } catch (err) {
      this.log(`Recompile/redeploy failed: ${err}`);
      vscode.window.showErrorMessage(`Recompile failed: ${err}`);
    }
  }

  // ── Infrastructure ──────────────────────────────────────────────

  private async startInfra(projectRoot: string): Promise<void> {
    const composePath = this.findComposePath(projectRoot);
    if (!composePath) {
      throw new Error('No docker-compose.yml found in project or workspace');
    }

    const composeDir = path.dirname(composePath);
    this.log(`Using docker-compose at: ${composePath}`);

    // Check if services are already running
    const alreadyUp = await this.probeInfra();
    if (alreadyUp.nats === 'up' && alreadyUp.etcd === 'up') {
      this.log('NATS and etcd already running — adopting');
      this._infraStatus = alreadyUp;
      this._onStatusChange.fire(this._infraStatus);
      return;
    }

    this.log('Starting docker compose...');
    try {
      const result = execSync('docker compose up -d --wait', {
        cwd: composeDir,
        timeout: 60000,
        stdio: 'pipe',
      });
      this.log(result.toString().trim() || 'Docker compose services started');
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? '';
      throw new Error(`docker compose up failed: ${stderr}`);
    }

    // Wait for services to be healthy
    this.log('Waiting for services...');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const status = await this.probeInfra();
      if (status.nats === 'up' && status.etcd === 'up') {
        this._infraStatus = status;
        this._onStatusChange.fire(this._infraStatus);
        this.log('NATS and etcd are healthy');
        return;
      }
      await sleep(1000);
    }

    throw new Error('Infrastructure did not become healthy within timeout');
  }

  private async compile(projectRoot: string): Promise<void> {
    this.log('Compiling project...');
    const cliPath = this.getCliPath();
    try {
      const result = execSync(`node "${cliPath}" build "${projectRoot}"`, {
        cwd: projectRoot,
        timeout: 30000,
        stdio: 'pipe',
      });
      const out = result.toString().trim();
      if (out) this.log(out);
      this.log('Compilation complete');
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? '';
      const stdout = err.stdout?.toString() ?? '';
      throw new Error(`Compilation failed:\n${stdout}\n${stderr}`);
    }
  }

  private async connectAndDeploy(projectRoot: string): Promise<void> {
    this.log('Connecting to cluster...');
    await this.clusterPanel.connect();
    this.log('Cluster connected');

    // Wait for at least one MCP gate to register
    this.log('Waiting for MCP gate nodes to register...');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = this.clusterPanel.getState();
      if (state.nodes.length > 0) {
        this.log(`Nodes online: ${state.nodes.map(n => n.nodeId).join(', ')}`);
        break;
      }
      await sleep(500);
    }

    if (this.clusterPanel.getState().nodes.length === 0) {
      this.log('No MCP gate nodes registered yet — deploying anyway (gates will pick up on connect)');
    }

    this.log('Deploying project...');
    await deployProject(this.clusterPanel, projectRoot);
    this.log('Deploy complete');
  }

  // ── Health monitoring ───────────────────────────────────────────

  private startHealthPolling(): void {
    this.stopHealthPolling();
    this.healthTimer = setInterval(async () => {
      const status = await this.probeInfra();
      status.admin = this.clusterPanel.getRapClient()?.connected ? 'up' : 'down';
      const changed =
        status.nats !== this._infraStatus.nats ||
        status.etcd !== this._infraStatus.etcd ||
        status.admin !== this._infraStatus.admin;
      this._infraStatus = status;
      if (changed) {
        this._onStatusChange.fire(status);
        this.updateStatusBar();
      }
    }, 5000);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async probeInfra(): Promise<InfraStatus> {
    const [nats, etcd] = await Promise.all([
      tcpProbe(4222, 1000),
      tcpProbe(2379, 1000),
    ]);
    return {
      nats: nats ? 'up' : 'down',
      etcd: etcd ? 'up' : 'down',
      admin: this.clusterPanel.getRapClient()?.connected ? 'up' : 'down',
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private findProjectRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      let dir = path.dirname(editor.document.uri.fsPath);
      for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'reagent.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (fs.existsSync(path.join(folder.uri.fsPath, 'reagent.json'))) {
        return folder.uri.fsPath;
      }
    }
    return undefined;
  }

  private findComposePath(projectRoot: string): string | null {
    const candidates = [
      path.join(projectRoot, 'docker-compose.yml'),
      path.join(projectRoot, 'docker-compose.yaml'),
      path.join(projectRoot, 'compose.yml'),
      path.join(projectRoot, 'compose.yaml'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const wsCompose = path.join(folder.uri.fsPath, 'docker-compose.yml');
      if (fs.existsSync(wsCompose)) return wsCompose;
    }

    return null;
  }

  private updateStatusBar(): void {
    if (!this._running) {
      this.statusBar.text = '';
      return;
    }

    const s = this._infraStatus;
    const icon = (v: string) => v === 'up' ? '$(pass)' : v === 'down' ? '$(error)' : '$(question)';

    this.statusBar.text = `$(rocket) MCP Dev  ${icon(s.nats)}NATS ${icon(s.etcd)}etcd ${icon(s.admin)}Admin`;
    this.statusBar.tooltip = [
      `NATS: ${s.nats}`,
      `etcd: ${s.etcd}`,
      `Admin: ${s.admin}`,
      '',
      'Click to stop MCP Dev Cycle',
    ].join('\n');

    const allUp = s.nats === 'up' && s.etcd === 'up' && s.admin === 'up';
    this.statusBar.backgroundColor = allUp
      ? undefined
      : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  private log(msg: string): void {
    const time = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${time}] ${msg}`);
  }

  dispose(): void {
    this.stop();
    this.statusBar.dispose();
    this.outputChannel.dispose();
    this._onStatusChange.dispose();
  }
}

function tcpProbe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
