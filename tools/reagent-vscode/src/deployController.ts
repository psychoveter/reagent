import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ClusterPanelProvider } from './clusterPanel';

/**
 * Reads a compiled Reagent project (out/ directory) and sends
 * DeployProject RAP to ROS so agents get distributed to connected nodes.
 */
export async function deployProject(cluster: ClusterPanelProvider, explicitRoot?: string): Promise<void> {
  const rap = cluster.getRapClient();
  if (!rap?.connected) {
    vscode.window.showErrorMessage('Not connected to cluster. Run "Reagent: Connect to Cluster" first.');
    return;
  }

  const state = cluster.getState();
  if (state.nodes.length === 0) {
    vscode.window.showWarningMessage('No remote nodes connected. Start at least one node first.');
    return;
  }

  const projectRoot = explicitRoot ?? await pickProjectRoot();
  if (!projectRoot) return;

  const outDir = path.join(projectRoot, 'out');
  const deploymentPath = path.join(outDir, 'deployment.json');

  if (!fs.existsSync(deploymentPath)) {
    const compile = await vscode.window.showWarningMessage(
      'No compiled output found (out/deployment.json). Compile the project first.',
      'OK',
    );
    return;
  }

  try {
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));
    const irGraphs: Record<string, unknown> = {};
    const roleIRs: Record<string, unknown> = {};

    for (const agent of deployment.agents ?? []) {
      const roleName = agent.roleName as string;
      if (roleName && !roleIRs[roleName]) {
        const roleIRFile = agent.roleIRFile as string;
        if (roleIRFile) {
          const roleIRPath = path.join(outDir, roleIRFile);
          if (fs.existsSync(roleIRPath)) {
            roleIRs[roleName] = JSON.parse(fs.readFileSync(roleIRPath, 'utf-8'));
          }
        }
      }

      for (const role of agent.roles ?? []) {
        const key = `${role.protocolName}.${role.roleName}`;
        if (!irGraphs[key] && role.irGraphFile) {
          const graphPath = path.join(outDir, role.irGraphFile);
          if (fs.existsSync(graphPath)) {
            irGraphs[key] = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
          }
        }
      }
    }

    const resp = await rap.request(
      'DeployProject',
      { deployment, irGraphs, roleIRs },
      'DeployProjectSuccess',
      15000,
    );

    const p = (resp.payload ?? {}) as Record<string, unknown>;

    if (resp.rap === 'DeployProjectFailed') {
      vscode.window.showErrorMessage(`Deploy failed: ${p.error ?? 'Unknown error'}`);
      return;
    }

    vscode.window.showInformationMessage(
      `Deployed ${p.deployed ?? '?'}/${p.total ?? '?'} agents across ${p.adapterCount ?? '?'} node(s)`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Deploy failed: ${err}`);
  }
}

async function pickProjectRoot(): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showWarningMessage('No workspace folder open');
    return undefined;
  }

  const candidates: Array<{ label: string; path: string }> = [];

  for (const folder of workspaceFolders) {
    await findReagentProjects(folder.uri.fsPath, candidates, 3);
  }

  if (candidates.length === 0) {
    vscode.window.showWarningMessage('No reagent.json found in workspace');
    return undefined;
  }

  if (candidates.length === 1) {
    return candidates[0].path;
  }

  const pick = await vscode.window.showQuickPick(
    candidates.map(c => ({ label: c.label, description: c.path })),
    { placeHolder: 'Select Reagent project to deploy' },
  );

  return pick?.description;
}

async function findReagentProjects(
  dir: string,
  results: Array<{ label: string; path: string }>,
  maxDepth: number,
): Promise<void> {
  if (maxDepth <= 0) return;

  const reagentJson = path.join(dir, 'reagent.json');
  if (fs.existsSync(reagentJson)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(reagentJson, 'utf-8'));
      results.push({
        label: manifest.name ?? path.basename(dir),
        path: dir,
      });
    } catch {
      results.push({ label: path.basename(dir), path: dir });
    }
    return;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'out') {
        await findReagentProjects(path.join(dir, entry.name), results, maxDepth - 1);
      }
    }
  } catch { /* permission errors etc. */ }
}
