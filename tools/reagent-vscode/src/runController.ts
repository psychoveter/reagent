import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let _compiler: {
  parseProgram: (src: string) => any;
  emitIR: (proto: any) => any;
  emitRoleIR: (role: any, roleMap: any) => any;
  emitAgentIR: (agent: any, roleMap: any) => any;
  emitMessageSchema: (msg: any) => any;
  resetIdCounter: () => void;
  validateIRGraph: (graph: any) => any;
} | null = null;

async function getCompiler(langDistPath: string) {
  if (_compiler) return _compiler;
  const parser = await import(path.join(langDistPath, 'parser.js'));
  const emitter = await import(path.join(langDistPath, 'ir-emitter.js'));
  const validator = await import(path.join(langDistPath, 'ir-validator.js'));
  _compiler = {
    parseProgram: parser.parseProgram,
    emitIR: emitter.emitIR,
    emitRoleIR: emitter.emitRoleIR,
    emitAgentIR: emitter.emitAgentIR,
    emitMessageSchema: emitter.emitMessageSchema,
    resetIdCounter: emitter.resetIdCounter,
    validateIRGraph: validator.validateIRGraph,
  };
  return _compiler;
}

export class RunController implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private running = false;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Reagent Run');
  }

  async run(rgFilePath: string): Promise<void> {
    if (this.running) {
      vscode.window.showWarningMessage('A Reagent protocol is already running');
      return;
    }

    this.running = true;
    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`▶ Running ${path.basename(rgFilePath)}...`);
    const startTime = Date.now();

    try {
      await this.runTsInProcess(rgFilePath, startTime);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      this.outputChannel.appendLine(`\n✗ Failed after ${elapsed}ms: ${err}`);
      vscode.window.showErrorMessage(`Reagent run failed: ${err}`);
    } finally {
      this.running = false;
    }
  }

  private async runTsInProcess(rgFilePath: string, startTime: number): Promise<void> {
      const rgSource = fs.readFileSync(rgFilePath, 'utf-8');

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const langDistPath = this.findLangDist(rgFilePath, workspaceFolder);
      if (!langDistPath) {
        throw new Error('Cannot find @reagent/lang compiler. Expected at lang/dist/ relative to the .rg file or workspace root.');
      }

      const compiler = await getCompiler(langDistPath);
      const compiled = this.compile(compiler, rgSource, path.basename(rgFilePath));

      const runtimeDistPath = this.findRuntimeDist(rgFilePath, workspaceFolder);
      if (!runtimeDistPath) {
        throw new Error('Cannot find @reagent/agent-runtime. Expected at runtime/ts/dist/ relative to the .rg file or workspace root.');
      }

      const { ReagentController } = await import(path.join(runtimeDistPath, 'reagent-controller.js'));
      const { ManagedBehaviorFactory } = await import(path.join(runtimeDistPath, 'managed-behavior-factory.js'));

      const deployment = compiled.deployment as {
        agents: Array<{ agentName: string; lang: string; roleName: string; roles: Array<{ protocolName: string; roleName: string }> }>;
        roleToAgent: Record<string, string>;
      };

      const traceHook = (event: Record<string, unknown>) => {
        const kind = event.kind as string || 'trace';
        const agent = event.agentName as string || '';
        this.outputChannel.appendLine(`  [${kind}] ${agent}: ${JSON.stringify(event)}`);
      };

      const factory = new ManagedBehaviorFactory();

      const rc = new ReagentController({
        nodeId: 'run-local',
        behaviorFactories: { ts: factory, '*': factory },
        traceHook,
      });

      for (const agentDef of deployment.agents) {
        const roleIR = compiled.roleIRs.get(agentDef.roleName);
        if (!roleIR) throw new Error(`Role IR not found: ${agentDef.roleName}`);

        const agentGraphs = new Map<string, unknown>();
        for (const binding of agentDef.roles) {
          const key = `${binding.protocolName}.${binding.roleName}`;
          const graph = compiled.irGraphs.get(key);
          if (graph) agentGraphs.set(key, graph);
        }
        rc.registerAgent(agentDef.agentName, roleIR, agentGraphs);
      }

      await rc.start();

      const firstAgent = deployment.agents[0];
      if (firstAgent) {
        const firstRole = firstAgent.roles[0];
        if (firstRole) {
          const { randomUUID } = await import('node:crypto');
          const instanceId = randomUUID();
          for (const agentDef of deployment.agents) {
            for (const binding of agentDef.roles) {
              if (binding.protocolName === firstRole.protocolName) {
                rc.triggerProtocol(agentDef.agentName, {
                  instanceId,
                  protocolName: binding.protocolName,
                  input: {},
                  roleToAgent: deployment.roleToAgent,
                });
              }
            }
          }
        }
      }

      await this.waitForCompletion(rc, deployment.agents, 30000);

      const elapsed = Date.now() - startTime;
      this.outputChannel.appendLine(`\n✓ Completed in ${elapsed}ms`);
      vscode.window.showInformationMessage(`Reagent: ${path.basename(rgFilePath)} completed in ${elapsed}ms`);
  }

  private compile(compiler: NonNullable<typeof _compiler>, rgSource: string, fileName: string) {
    const parseResult = compiler!.parseProgram(rgSource);
    if (!parseResult.ok) {
      const msgs = parseResult.errors.map((e: any) => `${e.loc.start.line}:${e.loc.start.col} ${e.message}`);
      throw new Error(`Parse errors:\n  ${msgs.join('\n  ')}`);
    }

    const items = parseResult.ast.items;
    const protocols = items.filter((i: any) => i.kind === 'ProtocolDef');
    const agents = items.filter((i: any) => i.kind === 'AgentDef');
    const roles = items.filter((i: any) => i.kind === 'RoleDef');

    const roleMap = new Map<string, any>();
    for (const r of roles) roleMap.set(r.name, r);

    const irGraphs = new Map<string, unknown>();
    const roleIRs = new Map<string, unknown>();

    for (const proto of protocols) {
      compiler!.resetIdCounter();
      const result = compiler!.emitIR(proto);
      if (!result.ok) throw new Error(`IR emit errors: ${result.errors.join(', ')}`);
      for (const [role, graph] of result.graphs) {
        irGraphs.set(`${proto.name}.${role}`, JSON.parse(JSON.stringify(graph)));
      }
    }

    for (const role of roles) {
      const result = compiler!.emitRoleIR(role, roleMap);
      if (!result.ok) throw new Error(`Role IR errors: ${result.errors.join(', ')}`);
      roleIRs.set(role.name, JSON.parse(JSON.stringify(result.roleIR)));
    }

    const roleToAgent: Record<string, string> = {};
    const deploymentAgents: Array<Record<string, any>> = [];

    for (const agent of agents) {
      const agentResult = compiler!.emitAgentIR(agent, roleMap);
      if (!agentResult.ok) throw new Error(`Agent IR errors: ${agentResult.errors.join(', ')}`);
      const roleName = agent.runs;
      const roleResult = roleMap.has(roleName) ? compiler!.emitRoleIR(roleMap.get(roleName)!, roleMap) : undefined;
      const plays = roleResult?.roleIR.plays ?? [];
      const da: Record<string, any> = {
        agentName: agent.name,
        lang: agentResult.agentIR.lang,
        roleName,
        roles: plays.map((p: any) => ({ protocolName: p.protocolName, roleName: p.roleName })),
      };
      for (const p of plays) roleToAgent[`${p.protocolName}.${p.roleName}`] = agent.name;
      deploymentAgents.push(da);
    }

    return { irGraphs, roleIRs, deployment: { agents: deploymentAgents, roleToAgent } };
  }

  private async waitForCompletion(rc: any, agents: Array<{ agentName: string }>, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        let allDone = true;
        for (const agentDef of agents) {
          const handle = rc.getAgent(agentDef.agentName);
          const runner = handle?.getRunner?.() ?? handle;
          const instances = runner?.getInstances?.() as Map<string, { getStatus: () => string }> | undefined;
          if (instances) {
            for (const [, inst] of instances) {
              const s = inst.getStatus();
              if (s !== 'completed' && s !== 'failed') allDone = false;
            }
          }
        }
        if (allDone || Date.now() > deadline) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  }

  private findLangDist(rgFilePath: string, workspaceRoot?: string): string | null {
    const candidates = [
      path.resolve(path.dirname(rgFilePath), '../../lang/dist'),
      path.resolve(path.dirname(rgFilePath), '../lang/dist'),
      workspaceRoot ? path.resolve(workspaceRoot, 'lang/dist') : null,
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'parser.js'))) return c;
    }
    return null;
  }

  private findRuntimeDist(rgFilePath: string, workspaceRoot?: string): string | null {
    const candidates = [
      path.resolve(path.dirname(rgFilePath), '../../runtime/ts/dist'),
      path.resolve(path.dirname(rgFilePath), '../runtime/ts/dist'),
      workspaceRoot ? path.resolve(workspaceRoot, 'runtime/ts/dist') : null,
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'reagent-controller.js'))) return c;
    }
    return null;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.outputChannel.dispose();
  }
}
