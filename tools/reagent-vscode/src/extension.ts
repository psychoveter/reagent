import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import {
  ReagentVirtualDocumentProvider,
  REAGENT_EMBEDDED_SCHEME,
  makeEmbeddedUri,
} from './virtualDocumentProvider';
import { parseReagentDocument } from './reagentParser';
import {
  registerCompletionDelegation,
  registerHoverDelegation,
  registerDefinitionDelegation,
  setupDiagnosticForwarding,
} from './embeddedLanguageMiddleware';
import { ReagentDebugAdapterFactory, ReagentDebugSession } from './reagentDebugAdapter';
import { ReagentDebugPanelProvider } from './debugPanelProvider';
import { ReagentInlineValues } from './inlineValues';
import { ReagentDiagramPanel } from './diagramPanel';
import { RunController } from './runController';
import { ReagentCodeLensProvider } from './codeLensProvider';
import { RosManager } from './rosManager';
import { DiagramController } from './diagramController';
import { ProjectDiagramPanel } from './projectDiagramPanel';
import { ClusterPanelProvider } from './clusterPanel';
import { ReagentTracePanelProvider } from './tracePanel';
import { deployProject } from './deployController';
import { ProjectCodeLensProvider } from './projectCodeLens';
import { McpDevCycle } from './mcpDevCycle';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as fs from 'fs';

let languageClient: LanguageClient | undefined;
let remoteNodeProcess: ChildProcess | null = null;
let remoteNodeChannel: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Reagent Language');
  outputChannel.appendLine('Reagent Language extension activating...');

  // ── Language Server ───────────────────────────────────────────────
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'reagent' }],
    outputChannel,
  };
  languageClient = new LanguageClient('reagent-lsp', 'Reagent Language Server', serverOptions, clientOptions);
  languageClient.start();
  context.subscriptions.push({ dispose: () => { languageClient?.stop(); } });

  // 1. Register virtual document provider
  const virtualProvider = new ReagentVirtualDocumentProvider();
  const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
    REAGENT_EMBEDDED_SCHEME,
    virtualProvider
  );
  context.subscriptions.push(providerRegistration);
  context.subscriptions.push(virtualProvider);

  // 2. Track unique embedded languages per open .rg document
  //    and open their virtual documents to activate respective language servers
  const activeVirtualDocs = new Set<string>();

  async function ensureVirtualDocsForReagentFile(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'reagent') { return; }

    const parsed = parseReagentDocument(document.getText());
    const uniqueLangs = new Set(parsed.zones.map(z => z.lang));

    for (const lang of uniqueLangs) {
      const virtualUri = makeEmbeddedUri(document.uri, lang);
      const key = virtualUri.toString();

      if (!activeVirtualDocs.has(key)) {
        activeVirtualDocs.add(key);
        try {
          // Opening the virtual document triggers VS Code to provide
          // language services for its language ID (derived from extension)
          await vscode.workspace.openTextDocument(virtualUri);
          outputChannel.appendLine(`Opened virtual doc: ${virtualUri.toString()}`);
        } catch (err) {
          outputChannel.appendLine(`Failed to open virtual doc: ${err}`);
        }
      }
    }
  }

  // 3. When .rg files are opened or changed, refresh virtual docs
  const onOpenDisposable = vscode.workspace.onDidOpenTextDocument(async (doc) => {
    if (doc.languageId === 'reagent') {
      await ensureVirtualDocsForReagentFile(doc);
    }
  });

  const onChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (e) => {
    if (e.document.languageId === 'reagent') {
      // Notify virtual document provider that content changed
      const parsed = parseReagentDocument(e.document.getText());
      const uniqueLangs = new Set(parsed.zones.map(z => z.lang));
      for (const lang of uniqueLangs) {
        const virtualUri = makeEmbeddedUri(e.document.uri, lang);
        virtualProvider.fireChange(virtualUri);
      }
    }
  });

  context.subscriptions.push(onOpenDisposable);
  context.subscriptions.push(onChangeDisposable);

  // 4. Register language feature delegation
  registerCompletionDelegation(context);
  registerHoverDelegation(context);
  registerDefinitionDelegation(context);

  // 5. Setup diagnostic forwarding
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('reagent-embedded');
  context.subscriptions.push(diagnosticCollection);
  setupDiagnosticForwarding(context, diagnosticCollection);

  // 6. Open virtual docs for any already-open .rg files
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'reagent') {
      ensureVirtualDocsForReagentFile(doc);
    }
  }

  // ── Debug panel webview ────────────────────────────────────────
  const debugPanelProvider = new ReagentDebugPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReagentDebugPanelProvider.viewType,
      debugPanelProvider
    )
  );

  // ── Inline value decorations ───────────────────────────────────
  const inlineValues = new ReagentInlineValues();
  context.subscriptions.push(inlineValues);

  // ── ROS manager (auto-start/stop) ──────────────────────────────
  const rosManager = new RosManager();
  context.subscriptions.push(rosManager);

  // ── Cluster panel (tree view in explorer + debug sidebar) ────────
  const clusterPanel = new ClusterPanelProvider(rosManager);
  context.subscriptions.push(clusterPanel);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(ClusterPanelProvider.viewType, clusterPanel)
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('reagentDebugCluster', clusterPanel)
  );

  // ── Trace panel (sidebar, outside debug sessions + debug sidebar)
  const tracePanelProvider = new ReagentTracePanelProvider(clusterPanel);
  context.subscriptions.push(tracePanelProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReagentTracePanelProvider.viewType,
      tracePanelProvider,
    )
  );
  const debugTracePanelProvider = new ReagentTracePanelProvider(clusterPanel);
  context.subscriptions.push(debugTracePanelProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'reagentDebugTracePanel',
      debugTracePanelProvider,
    )
  );

  // ── Debug adapter (wired to panel + inline values + ROS manager) ─
  const debugAdapterFactory = new ReagentDebugAdapterFactory({
    debugPanel: debugPanelProvider,
    inlineValues,
  }, rosManager);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('reagent', debugAdapterFactory)
  );

  let previousToolBarLocation: string | undefined;

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      if (session.type === 'reagent') {
        vscode.commands.executeCommand('setContext', 'reagent.debugActive', true);
        // Dock the native debug toolbar into the debug viewlet
        const config = vscode.workspace.getConfiguration('debug');
        previousToolBarLocation = config.get<string>('toolBarLocation');
        if (previousToolBarLocation !== 'docked') {
          config.update('toolBarLocation', 'docked', vscode.ConfigurationTarget.Global);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      if (session.type === 'reagent') {
        inlineValues.clearDecorations();
        debugPanelProvider.clear();
        vscode.commands.executeCommand('setContext', 'reagent.debugActive', false);
        // Restore previous toolbar location
        if (previousToolBarLocation !== undefined && previousToolBarLocation !== 'docked') {
          const config = vscode.workspace.getConfiguration('debug');
          config.update('toolBarLocation', previousToolBarLocation, vscode.ConfigurationTarget.Global);
        }
        previousToolBarLocation = undefined;
      }
    })
  );

  // ── Debug commands (sidebar panel → diagram panel bridge) ────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.debug.continue', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('continue');
    }),
    vscode.commands.registerCommand('reagent.debug.stepState', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stepState');
    }),
    vscode.commands.registerCommand('reagent.debug.stepOver', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stepOver');
    }),
    vscode.commands.registerCommand('reagent.debug.stepInto', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stepInto');
    }),
    vscode.commands.registerCommand('reagent.debug.restart', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('restart');
    }),
    vscode.commands.registerCommand('reagent.debug.stop', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stop');
    }),
  );
  debugPanelProvider.setDiagramPanelAccessor(() => ReagentDiagramPanel.getInstance() ?? null);

  // ── Diagram ↔ Debug controller ──────────────────────────────
  const diagramController = new DiagramController();
  context.subscriptions.push(diagramController);

  // ── Run controller (no-debug, in-process) ─────────────────────
  const runController = new RunController();
  context.subscriptions.push(runController);

  // ── CodeLens (▶ Run / 🔍 Debug on protocol lines) ────────────
  const codeLensProvider = new ReagentCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'reagent' }, codeLensProvider)
  );
  context.subscriptions.push(codeLensProvider);

  // ── CodeLens for reagent.json (Compile / Deploy / Trigger) ────
  const projectCodeLens = new ProjectCodeLensProvider();
  context.subscriptions.push(projectCodeLens);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { pattern: '**/reagent.json' },
      projectCodeLens,
    )
  );

  // ── Commands ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.run', async (rgFilePath?: string) => {
      if (!rgFilePath) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'reagent') {
          vscode.window.showWarningMessage('Open a .rg file first');
          return;
        }
        rgFilePath = editor.document.uri.fsPath;
      }
      await runController.run(rgFilePath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.startDebug', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'reagent') {
        vscode.window.showWarningMessage('Open a .rg file first');
        return;
      }
      await vscode.debug.startDebugging(undefined, {
        type: 'reagent',
        request: 'launch',
        name: 'Debug Reagent Protocol',
        rgFile: editor.document.uri.fsPath,
      });
    })
  );

  // ── Trace output channel (always available) ─────────────────────
  const traceChannel = vscode.window.createOutputChannel('Reagent Traces');
  context.subscriptions.push(traceChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.showTraceTimeline', () => {
      traceChannel.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.inspectAgent', async () => {
      const session = ReagentDebugSession.activeSession;
      const rap = session?.getRapClient();
      const sessionId = session?.getSessionId();
      if (!rap?.connected || !sessionId) {
        vscode.window.showWarningMessage('No active Reagent debug session');
        return;
      }

      const agentName = await vscode.window.showInputBox({
        prompt: 'Agent name to inspect',
        placeHolder: 'e.g. handler',
      });
      if (!agentName) return;

      rap.send({
        rap: 'GetState',
        sessionId,
        payload: { sessionId, agentName },
      });

      const disposable = rap.on('StateSnapshot', (msg) => {
        disposable.dispose();
        const snap = (msg.payload || {}) as Record<string, unknown>;
        outputChannel.appendLine(`\n── Inspect: ${agentName} ──`);
        outputChannel.appendLine(`$self: ${JSON.stringify(snap.self, null, 2)}`);
        if (snap.ctx) outputChannel.appendLine(`$ctx: ${JSON.stringify(snap.ctx, null, 2)}`);
        const held = snap.heldMessages as unknown[] | undefined;
        if (held?.length) outputChannel.appendLine(`Held messages: ${JSON.stringify(held, null, 2)}`);
        const traces = snap.recentTraces as unknown[] | undefined;
        if (traces?.length) outputChannel.appendLine(`Recent traces (last ${traces.length}):`);
        outputChannel.show(true);
      });

      const errorDisposable = rap.on('InspectError', (msg) => {
        errorDisposable.dispose();
        const err = (msg.payload as Record<string, unknown>)?.error || 'Unknown error';
        vscode.window.showErrorMessage(`Inspect ${agentName}: ${err}`);
      });

      setTimeout(() => { disposable.dispose(); errorDisposable.dispose(); }, 5000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.openDiagram', () => {
      ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.openProjectDiagram', () => {
      ProjectDiagramPanel.createOrShow();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.startRos', () => rosManager.start())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.stopRos', () => rosManager.stop())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.toggleRos', () => {
      if (rosManager.running) { rosManager.stop(); } else { rosManager.start(); }
    })
  );

  clusterPanel.setTraceChannel(traceChannel);

  // Make cluster view visible by default when reagent extension is active
  vscode.commands.executeCommand('setContext', 'reagent.clusterVisible', true);

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.connectCluster', async () => {
      const ok = await rosManager.ensureRunning();
      if (!ok) {
        vscode.window.showErrorMessage('Cannot connect: ROS is not running');
        return;
      }
      await clusterPanel.connect();
      vscode.window.showInformationMessage('Connected to Reagent cluster');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.disconnectCluster', () => {
      clusterPanel.disconnect();
      vscode.window.showInformationMessage('Disconnected from Reagent cluster');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.refreshCluster', () => {
      if (clusterPanel.getRapClient()?.connected) {
        clusterPanel.getRapClient()!.send({ rap: 'ClusterStatus', payload: {} });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.triggerProtocol', () => {
      if (!clusterPanel.getRapClient()?.connected) {
        vscode.window.showWarningMessage('Connect to the cluster first (Reagent: Connect to Cluster)');
        return;
      }
      ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.compileProject', async (projectDir?: string) => {
      if (!projectDir) {
        const editor = vscode.window.activeTextEditor;
        if (editor && path.basename(editor.document.uri.fsPath) === 'reagent.json') {
          projectDir = path.dirname(editor.document.uri.fsPath);
        }
      }
      if (!projectDir) {
        vscode.window.showWarningMessage('Open a reagent.json file or provide a project directory');
        return;
      }

      const cliPath = context.asAbsolutePath(path.join('lang', 'cli.js'));
      const terminal = vscode.window.createTerminal({
        name: 'Reagent Compile',
        cwd: projectDir,
      });
      terminal.show();
      terminal.sendText(`node "${cliPath}" build "${projectDir}"`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.deployProject', (projectDir?: string) => {
      deployProject(clusterPanel, projectDir);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.inspectNode', (treeItem?: any) => {
      let nodeId: string | undefined;
      if (treeItem?.node?.nodeId) {
        nodeId = treeItem.node.nodeId;
      }
      if (!nodeId) {
        const nodes = clusterPanel.getState().nodes;
        if (nodes.length === 0) {
          vscode.window.showWarningMessage('No nodes connected');
          return;
        }
        vscode.window.showQuickPick(
          nodes.map(n => ({ label: n.nodeId, description: n.status })),
          { placeHolder: 'Select node to inspect' }
        ).then(pick => {
          if (pick) clusterPanel.requestNodeInspect(pick.label);
        });
        return;
      }
      clusterPanel.requestNodeInspect(nodeId);
    })
  );

  // ── Cluster tree → diagram/source navigation ────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.clusterOpenProtocol', async (protocolName?: string) => {
      if (!protocolName) return;

      // Search workspace for .rg files containing this protocol definition
      const files = await vscode.workspace.findFiles('**/*.rg', '**/node_modules/**', 100);
      for (const uri of files) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const text = doc.getText();
          const pattern = new RegExp(`^\\s*protocol\\s+${protocolName}\\b`, 'm');
          const match = pattern.exec(text);
          if (match) {
            const line = text.substring(0, match.index).split('\n').length - 1;
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(line, 0, line, 0),
              viewColumn: vscode.ViewColumn.One,
            });
            ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
            return;
          }
        } catch { /* skip unreadable files */ }
      }

      vscode.window.showWarningMessage(`Protocol "${protocolName}" not found in workspace .rg files`);
    })
  );

  // ── Dev Cycle: one-click setup ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.devCycle', async () => {
      const devChannel = remoteNodeChannel ?? vscode.window.createOutputChannel('Reagent Node');
      remoteNodeChannel = devChannel;
      context.subscriptions.push(devChannel);
      devChannel.show(true);

      // 1. Find project root from active .rg file
      const editor = vscode.window.activeTextEditor;
      let projectRoot: string | undefined;
      if (editor) {
        let dir = path.dirname(editor.document.uri.fsPath);
        for (let i = 0; i < 6; i++) {
          if (fs.existsSync(path.join(dir, 'reagent.json'))) { projectRoot = dir; break; }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (!projectRoot) {
        vscode.window.showWarningMessage('Open a .rg file inside a Reagent project first');
        return;
      }

      devChannel.appendLine(`[DevCycle] Project: ${projectRoot}`);

      // 2. Ensure ROS running
      devChannel.appendLine('[DevCycle] Starting ROS...');
      const rosOk = await rosManager.ensureRunning();
      if (!rosOk) {
        vscode.window.showErrorMessage('Dev Cycle: ROS failed to start');
        return;
      }
      devChannel.appendLine('[DevCycle] ROS ready');

      // 3. Connect cluster
      devChannel.appendLine('[DevCycle] Connecting to cluster...');
      await clusterPanel.connect();
      devChannel.appendLine('[DevCycle] Cluster connected');

      // 4. Compile project
      devChannel.appendLine('[DevCycle] Compiling project...');
      const cliPath = context.asAbsolutePath(path.join('lang', 'cli.js'));
      try {
        execSync(`node "${cliPath}" build "${projectRoot}"`, {
          cwd: projectRoot,
          timeout: 30000,
          stdio: 'pipe',
        });
        devChannel.appendLine('[DevCycle] Compilation complete');
      } catch (err: any) {
        const stderr = err.stderr?.toString() ?? '';
        const stdout = err.stdout?.toString() ?? '';
        devChannel.appendLine(`[DevCycle] Compile failed:\n${stdout}\n${stderr}`);
        vscode.window.showErrorMessage('Dev Cycle: compilation failed — check Reagent Node output');
        return;
      }

      // 5. Kill previous remote node if still alive
      if (remoteNodeProcess && !remoteNodeProcess.killed) {
        devChannel.appendLine('[DevCycle] Killing previous remote node...');
        remoteNodeProcess.kill('SIGTERM');
        remoteNodeProcess = null;
        await new Promise(r => setTimeout(r, 500));
      }

      // 6. Start Python remote node
      devChannel.appendLine('[DevCycle] Starting remote node...');
      const runtimePyDir = findRuntimePyDir(projectRoot);
      if (!runtimePyDir) {
        vscode.window.showErrorMessage('Dev Cycle: cannot find runtime/py directory');
        return;
      }

      const agentsDir = path.join(projectRoot, 'agents');
      const pythonPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || 'python3';

      remoteNodeProcess = spawn(
        pythonPath,
        ['-m', 'reagent_runtime.remote_node_cli',
          '--ros-url', rosManager.rosUrl,
          '--node-id', 'node-py-1',
          '--agents-dir', agentsDir,
          '--no-repl',
        ],
        { cwd: runtimePyDir, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      remoteNodeProcess.stdout?.on('data', (data: Buffer) => {
        devChannel.append(data.toString());
      });
      remoteNodeProcess.stderr?.on('data', (data: Buffer) => {
        devChannel.append(data.toString());
      });
      remoteNodeProcess.on('exit', (code) => {
        devChannel.appendLine(`[DevCycle] Remote node exited (code ${code})`);
        remoteNodeProcess = null;
      });

      // 7. Wait for node to register (poll cluster state)
      devChannel.appendLine('[DevCycle] Waiting for node registration...');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        const state = clusterPanel.getState();
        if (state.nodes.length > 0) break;
      }
      if (clusterPanel.getState().nodes.length === 0) {
        vscode.window.showErrorMessage('Dev Cycle: remote node did not register in time');
        return;
      }
      devChannel.appendLine(`[DevCycle] Node registered: ${clusterPanel.getState().nodes.map(n => n.nodeId).join(', ')}`);

      // 8. Deploy project
      devChannel.appendLine('[DevCycle] Deploying project...');
      await deployProject(clusterPanel, projectRoot);
      devChannel.appendLine('[DevCycle] Deploy complete');

      // 9. Open diagram
      ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
      devChannel.appendLine('[DevCycle] Ready — use the trigger bar to run the protocol');
    })
  );

  // ── MCP Dev Cycle: NATS + etcd + ROS + compile + deploy ─────────
  const mcpDevCycle = new McpDevCycle(
    rosManager,
    clusterPanel,
    () => context.asAbsolutePath(path.join('lang', 'cli.js')),
  );
  context.subscriptions.push(mcpDevCycle);

  mcpDevCycle.onStatusChange((health) => {
    clusterPanel.setInfraHealth(health);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.mcpDevCycle', () => mcpDevCycle.start())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.stopMcpDevCycle', () => mcpDevCycle.stop())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.teardownMcpDevCycle', () => mcpDevCycle.stop(true))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.mcpRedeploy', () => mcpDevCycle.recompileAndRedeploy())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.lspStatus', async () => {
      if (!languageClient) {
        vscode.window.showWarningMessage('Reagent LSP not running');
        return;
      }
      try {
        const status = await languageClient.sendRequest('reagent/lspStatus');
        const s = status as { parser: { state: string; error?: string }; indexedDocuments: number; uptimeSeconds: number };
        const parserLine = s.parser.state === 'error'
          ? `Parser: error — ${s.parser.error}`
          : `Parser: ${s.parser.state}`;
        const lines = [
          parserLine,
          `Indexed documents: ${s.indexedDocuments}`,
          `Uptime: ${s.uptimeSeconds}s`,
        ];
        vscode.window.showInformationMessage(`Reagent LSP Status\n${lines.join('\n')}`);
        outputChannel.appendLine(`[LSP Status] ${lines.join(' | ')}`);
      } catch (err) {
        vscode.window.showErrorMessage(`LSP Status request failed: ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.stopDevCycle', () => {
      if (remoteNodeProcess && !remoteNodeProcess.killed) {
        remoteNodeProcess.kill('SIGTERM');
        remoteNodeProcess = null;
        remoteNodeChannel?.appendLine('[DevCycle] Remote node stopped');
      }
      vscode.window.showInformationMessage('Dev Cycle: remote node stopped');
    })
  );

  outputChannel.appendLine('Reagent Language extension activated.');
}

function findRuntimePyDir(projectRoot: string): string | null {
  const candidates = [
    path.resolve(projectRoot, '../../runtime/py'),
    path.resolve(projectRoot, '../../../runtime/py'),
    path.resolve(projectRoot, '../../../../runtime/py'),
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(
      path.join(folder.uri.fsPath, 'projects', 'reagent', 'runtime', 'py'),
      path.join(folder.uri.fsPath, 'runtime', 'py'),
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'reagent_runtime', 'remote_node_cli.py'))) return c;
  }
  return null;
}

export function deactivate(): void {
  if (remoteNodeProcess && !remoteNodeProcess.killed) {
    remoteNodeProcess.kill('SIGTERM');
    remoteNodeProcess = null;
  }
}
