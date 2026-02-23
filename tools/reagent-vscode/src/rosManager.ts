import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { RapClient } from './rapClient';

export class RosManager implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private port = 18789;
  private host = '127.0.0.1';
  private outputChannel: vscode.OutputChannel;
  private statusBar: vscode.StatusBarItem;
  private _running = false;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Reagent ROS');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = 'reagent.toggleRos';
    this.updateStatusBar();
    this.statusBar.show();
  }

  get running(): boolean { return this._running; }
  get rosUrl(): string { return `ws://${this.host}:${this.port}`; }

  async start(): Promise<void> {
    if (this._running) return;

    const rosCliPath = this.findRosCli();
    if (!rosCliPath) {
      vscode.window.showErrorMessage(
        'Cannot find ROS CLI (ros-cli.ts). Expected at runtime/ts/src/ros-cli.ts relative to workspace.'
      );
      return;
    }

    const tsxPath = this.findTsx(rosCliPath);
    if (!tsxPath) {
      vscode.window.showErrorMessage('Cannot find tsx. Run `npm install` in runtime/ts/.');
      return;
    }

    this.outputChannel.appendLine(`Starting ROS on port ${this.port}...`);
    this.outputChannel.show(true);

    const cwd = path.dirname(path.dirname(rosCliPath));

    this.process = spawn(
      process.execPath,
      ['--import', 'tsx', rosCliPath, '--port', String(this.port)],
      {
        cwd,
        env: { ...process.env, NODE_PATH: path.join(cwd, 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.outputChannel.appendLine(text);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.outputChannel.appendLine(`[stderr] ${text}`);
    });

    this.process.on('exit', (code) => {
      this._running = false;
      this.outputChannel.appendLine(`ROS exited (code ${code})`);
      this.updateStatusBar();
    });

    // Wait for ROS to be reachable
    const ok = await this.waitForReady(5000);
    if (ok) {
      this._running = true;
      this.outputChannel.appendLine(`ROS ready at ${this.rosUrl}`);
    } else {
      this.outputChannel.appendLine('ROS failed to start within timeout');
      this.stop();
      vscode.window.showErrorMessage('ROS failed to start. Check Reagent ROS output.');
    }
    this.updateStatusBar();
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this._running = false;
    this.updateStatusBar();
    this.outputChannel.appendLine('ROS stopped');
  }

  async ensureRunning(): Promise<boolean> {
    if (this._running && await this.probe()) return true;

    // Maybe ROS is already running externally
    if (await this.probe()) {
      this._running = true;
      this.updateStatusBar();
      return true;
    }

    await this.start();
    return this._running;
  }

  private async probe(): Promise<boolean> {
    try {
      const client = new RapClient(this.rosUrl);
      await client.connect();
      client.close();
      return true;
    } catch {
      return false;
    }
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe()) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  private findRosCli(): string | null {
    const candidates: string[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(
        path.join(folder.uri.fsPath, 'projects', 'reagent', 'runtime', 'ts', 'src', 'ros-cli.ts'),
        path.join(folder.uri.fsPath, 'runtime', 'ts', 'src', 'ros-cli.ts'),
      );
    }

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private findTsx(rosCliPath: string): string | null {
    const runtimeTs = path.dirname(path.dirname(rosCliPath));
    const tsxBin = path.join(runtimeTs, 'node_modules', '.bin', 'tsx');
    return fs.existsSync(tsxBin) ? tsxBin : null;
  }

  private updateStatusBar(): void {
    if (this._running) {
      this.statusBar.text = '$(debug-start) ROS';
      this.statusBar.tooltip = `Reagent ROS running on port ${this.port} — click to stop`;
      this.statusBar.backgroundColor = undefined;
    } else {
      this.statusBar.text = '$(debug-stop) ROS';
      this.statusBar.tooltip = 'Reagent ROS stopped — click to start';
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  dispose(): void {
    this.stop();
    this.statusBar.dispose();
    this.outputChannel.dispose();
  }
}
