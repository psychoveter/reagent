import * as vscode from 'vscode';
import { RapClient } from './rapClient';

interface NodeInfo {
  nodeId: string;
  status: string;
  lastSeen: number;
}

interface AgentInfo {
  agentName: string;
  roleName: string;
  protocolName: string;
  nodeId: string;
  status: string;
}

interface ProtocolInfo {
  name: string;
  version: string;
  nodeId: string;
  boundAgents: string[];
}

interface ClusterState {
  nodes: NodeInfo[];
  agents: AgentInfo[];
  protocols: ProtocolInfo[];
  timestamp: number;
}

interface NodeInspectData {
  nodeId: string;
  agents: Array<{ name: string; lang: string; route: string }>;
  protocols: Array<{ name: string; version: string; agents: string[]; graphs: string[] }>;
  routing: Record<string, string>;
  agentNodes: string[];
}

export interface InfraHealth {
  nats: 'up' | 'down' | 'unknown';
  etcd: 'up' | 'down' | 'unknown';
  admin: 'up' | 'down' | 'unknown';
}

type TreeElement =
  | { type: 'category'; label: string; category: 'nodes' | 'protocols' | 'infra' }
  | { type: 'infraItem'; service: string; status: 'up' | 'down' | 'unknown' }
  | { type: 'node'; node: NodeInfo; agents: AgentInfo[] }
  | { type: 'nodeSection'; nodeId: string; section: 'agents' | 'protocols' | 'routing' }
  | { type: 'nodeAgent'; nodeId: string; agent: { name: string; lang: string; route: string } }
  | { type: 'nodeProtocol'; nodeId: string; protocol: { name: string; version: string; agents: string[]; graphs: string[] } }
  | { type: 'nodeRoute'; nodeId: string; agentName: string; route: string }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'protocol'; protocol: ProtocolInfo }
  | { type: 'empty'; label: string };

export class ClusterPanelProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
  static readonly viewType = 'reagentCluster';

  private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rap: RapClient | null = null;
  private state: ClusterState = { nodes: [], agents: [], protocols: [], timestamp: 0 };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposables: vscode.Disposable[] = [];
  private traceEntries: Array<{ kind: string; agent: string; ts: number; detail: string; protocolName?: string; role?: string; messageName?: string }> = [];
  private _traceChannel: import('vscode').OutputChannel | null = null;

  private nodeInspectCache = new Map<string, { data: NodeInspectData; fetchedAt: number }>();
  private nodeInspectPending = new Set<string>();
  private _infraHealth: InfraHealth = { nats: 'unknown', etcd: 'unknown', admin: 'unknown' };
  private lastConnectError: string | null = null;

  constructor() {}

  setInfraHealth(health: InfraHealth): void {
    this._infraHealth = health;
    this._onDidChangeTreeData.fire();
  }

  getInfraHealth(): InfraHealth {
    return { ...this._infraHealth };
  }

  setTraceChannel(channel: import('vscode').OutputChannel): void {
    this._traceChannel = channel;
  }

  async connect(): Promise<void> {
    if (this.rap?.connected) return;

    try {
      this.lastConnectError = null;
      this.rap = new RapClient('cluster://default');
      await this.rap.connect();

      this.disposables.push(this.rap.on('ClusterUpdate', (msg) => {
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        this.state = {
          nodes: (p.nodes as NodeInfo[]) ?? [],
          agents: (p.agents as AgentInfo[]) ?? [],
          protocols: (p.protocols as ProtocolInfo[]) ?? [],
          timestamp: (p.timestamp as number) ?? Date.now(),
        };
        this.pruneInspectCache();
        this._onDidChangeTreeData.fire();
      }));

      this.disposables.push(this.rap.on('ClusterStatusResponse', (msg) => {
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        this.state = {
          nodes: (p.nodes as NodeInfo[]) ?? [],
          agents: (p.agents as AgentInfo[]) ?? [],
          protocols: (p.protocols as ProtocolInfo[]) ?? [],
          timestamp: (p.timestamp as number) ?? Date.now(),
        };
        this.pruneInspectCache();
        this._onDidChangeTreeData.fire();
      }));

      this.disposables.push(this.rap.on('NodeInspectResult', (msg) => {
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        const nodeId = p.nodeId as string;
        if (nodeId && !p.error) {
          this.nodeInspectCache.set(nodeId, {
            data: p as unknown as NodeInspectData,
            fetchedAt: Date.now(),
          });
          this.nodeInspectPending.delete(nodeId);
          this._onDidChangeTreeData.fire();
        } else {
          this.nodeInspectPending.delete(p.nodeId as string ?? '');
        }
      }));

      this.disposables.push(this.rap.on('TraceEvent', (msg) => {
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        const kind = (p.kind ?? 'trace') as string;
        const agent = (p.agent ?? p.agentName ?? '') as string;
        const proto = (p.protocolName ?? '') as string;
        const role = (p.role ?? '') as string;
        const data = (p.data ?? {}) as Record<string, unknown>;
        const messageName = (data.messageName ?? '') as string;

        this.traceEntries.push({
          kind,
          agent,
          ts: Date.now(),
          detail: JSON.stringify(p),
          protocolName: proto,
          role,
          messageName,
        });
        if (this.traceEntries.length > 500) {
          this.traceEntries = this.traceEntries.slice(-250);
        }
        if (this._traceChannel) {
          const time = new Date().toLocaleTimeString();
          let line = `[${time}] ${kind}`;
          if (agent) line += ` ${agent}`;
          if (role) line += ` (${role})`;
          if (messageName) line += ` msg=${messageName}`;
          if (data.to) line += ` → ${data.to}`;
          if (data.from) line += ` ← ${data.from}`;
          if (data.error) line += ` error: ${data.error}`;
          this._traceChannel.appendLine(line);
        }
      }));

      this.startPolling();
      this.poll();
    } catch (err) {
      this.rap = null;
      this.lastConnectError = err instanceof Error ? err.message : String(err);
      this._onDidChangeTreeData.fire();
      throw err;
    }
  }

  disconnect(): void {
    this.stopPolling();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.rap?.close();
    this.rap = null;
    this.lastConnectError = null;
    this.state = { nodes: [], agents: [], protocols: [], timestamp: 0 };
    this.nodeInspectCache.clear();
    this.nodeInspectPending.clear();
    this._onDidChangeTreeData.fire();
  }

  getTraceEntries(): typeof this.traceEntries {
    return this.traceEntries;
  }

  getRapClient(): RapClient | null {
    return this.rap;
  }

  getState(): ClusterState {
    return this.state;
  }

  requestNodeInspect(nodeId: string): void {
    if (!this.rap?.connected) return;
    if (this.nodeInspectPending.has(nodeId)) return;
    this.nodeInspectPending.add(nodeId);
    this.rap.send({ rap: 'NodeInspect', payload: { nodeId } });
  }

  private pruneInspectCache(): void {
    const currentNodeIds = new Set(this.state.nodes.map(n => n.nodeId));
    for (const key of this.nodeInspectCache.keys()) {
      if (!currentNodeIds.has(key)) {
        this.nodeInspectCache.delete(key);
      }
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.poll(), 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    if (!this.rap?.connected) return;
    this.rap.send({ rap: 'ClusterStatus', payload: {} });
  }

  // ── TreeDataProvider ──────────────────────────────────────────

  getTreeItem(element: TreeElement): vscode.TreeItem {
    switch (element.type) {
      case 'category': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = `category-${element.category}`;
        return item;
      }
      case 'infraItem': {
        const icons: Record<string, string> = { up: 'pass', down: 'error', unknown: 'question' };
        const labels: Record<string, string> = { up: 'healthy', down: 'down', unknown: '?' };
        const item = new vscode.TreeItem(
          element.service,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(icons[element.status]);
        item.description = labels[element.status];
        item.contextValue = 'infraItem';
        return item;
      }
      case 'node': {
        const agentCount = element.agents.length;
        const item = new vscode.TreeItem(
          element.node.nodeId,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon(element.node.status === 'connected' ? 'server-process' : 'server');
        item.description = `${element.node.status} · ${agentCount} agent${agentCount !== 1 ? 's' : ''}`;
        item.contextValue = 'node';
        item.tooltip = new vscode.MarkdownString(
          `**Node:** ${element.node.nodeId}\n\n` +
          `Status: ${element.node.status}\n\n` +
          `Agents: ${agentCount}\n\n` +
          `Last seen: ${new Date(element.node.lastSeen).toLocaleTimeString()}`
        );
        return item;
      }
      case 'nodeSection': {
        const icons: Record<string, string> = {
          agents: 'symbol-event',
          protocols: 'symbol-interface',
          routing: 'git-merge',
        };
        const labels: Record<string, string> = {
          agents: 'Agents',
          protocols: 'Protocols',
          routing: 'Routing Table',
        };
        const cached = this.nodeInspectCache.get(element.nodeId);
        let count = '?';
        if (cached) {
          if (element.section === 'agents') count = String(cached.data.agents.length);
          else if (element.section === 'protocols') count = String(cached.data.protocols.length);
          else if (element.section === 'routing') count = String(Object.keys(cached.data.routing).length);
        }
        const item = new vscode.TreeItem(
          `${labels[element.section]} (${count})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(icons[element.section]);
        item.contextValue = `nodeSection-${element.section}`;
        return item;
      }
      case 'nodeRoute': {
        const item = new vscode.TreeItem(element.agentName, vscode.TreeItemCollapsibleState.None);
        item.description = `→ ${element.route}`;
        item.iconPath = new vscode.ThemeIcon('arrow-right');
        item.contextValue = 'nodeRoute';
        return item;
      }
      case 'agent': {
        const item = new vscode.TreeItem(element.agent.agentName, vscode.TreeItemCollapsibleState.None);
        item.description = `${element.agent.roleName} · ${element.agent.protocolName}`;
        item.contextValue = 'agent';
        item.iconPath = new vscode.ThemeIcon(
          element.agent.status === 'running' ? 'symbol-event' : 'circle-outline'
        );
        item.command = {
          command: 'reagent.openProjectDiagram',
          title: 'Open Project Diagram',
        };
        return item;
      }
      case 'nodeAgent': {
        const a = element.agent;
        const item = new vscode.TreeItem(a.name, vscode.TreeItemCollapsibleState.None);
        item.description = `lang=${a.lang}  route=${a.route}`;
        item.iconPath = new vscode.ThemeIcon('symbol-event');
        item.contextValue = 'nodeAgent';
        item.command = {
          command: 'reagent.openProjectDiagram',
          title: 'Open Project Diagram',
        };
        return item;
      }
      case 'protocol': {
        const item = new vscode.TreeItem(element.protocol.name, vscode.TreeItemCollapsibleState.None);
        item.description = `v${element.protocol.version}`;
        item.contextValue = 'protocol';
        item.iconPath = new vscode.ThemeIcon('symbol-interface');
        item.command = {
          command: 'reagent.clusterOpenProtocol',
          title: 'Open Protocol',
          arguments: [element.protocol.name],
        };
        return item;
      }
      case 'nodeProtocol': {
        const p = element.protocol;
        const agents = Array.isArray(p.agents) ? p.agents : [];
        const graphs = Array.isArray(p.graphs) ? p.graphs : [];
        const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.None);
        item.description = `v${p.version}  agents=[${agents.join(', ')}]`;
        item.iconPath = new vscode.ThemeIcon('symbol-interface');
        item.tooltip = new vscode.MarkdownString(
          `**${p.name}** v${p.version}\n\n` +
          `Agents: ${agents.join(', ') || '(none)'}\n\n` +
          `Graphs: ${graphs.join(', ') || '(none)'}`
        );
        item.contextValue = 'nodeProtocol';
        item.command = {
          command: 'reagent.clusterOpenProtocol',
          title: 'Open Protocol',
          arguments: [p.name],
        };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = '';
        return item;
      }
    }
  }

  getChildren(element?: TreeElement): TreeElement[] {
    if (!element) {
      const items: TreeElement[] = [];
      const h = this._infraHealth;
      const hasInfraData = h.nats !== 'unknown' || h.etcd !== 'unknown' || h.admin !== 'unknown';
      if (hasInfraData) {
        items.push({ type: 'category', label: 'Infrastructure', category: 'infra' });
      }
      if (!this.rap?.connected) {
        items.push({
          type: 'empty',
          label: this.lastConnectError
            ? `Cluster connect failed: ${this.lastConnectError}`
            : 'Not connected to cluster control plane',
        });
        return items;
      }
      items.push(
        { type: 'category', label: `Nodes (${this.state.nodes.length})`, category: 'nodes' },
        { type: 'category', label: `Protocols (${this.state.protocols.length})`, category: 'protocols' },
      );
      return items;
    }

    if (element.type === 'category') {
      if (element.category === 'infra') {
        const h = this._infraHealth;
        return [
          { type: 'infraItem', service: 'NATS', status: h.nats },
          { type: 'infraItem', service: 'etcd', status: h.etcd },
          { type: 'infraItem', service: 'Admin', status: h.admin },
        ];
      }
      if (element.category === 'nodes') {
        if (this.state.nodes.length === 0) {
          return [{ type: 'empty', label: 'No nodes connected' }];
        }
        return this.state.nodes.map(node => ({
          type: 'node' as const,
          node,
          agents: this.state.agents.filter(a => a.nodeId === node.nodeId),
        }));
      }
      if (element.category === 'protocols') {
        if (this.state.protocols.length === 0) {
          return [{ type: 'empty', label: 'No protocols deployed' }];
        }
        return this.state.protocols.map(p => ({ type: 'protocol' as const, protocol: p }));
      }
    }

    if (element.type === 'node') {
      const nodeId = element.node.nodeId;
      const cached = this.nodeInspectCache.get(nodeId);

      if (!cached && !this.nodeInspectPending.has(nodeId)) {
        this.requestNodeInspect(nodeId);
      }

      if (!cached) {
        return [{ type: 'empty', label: 'Loading node state...' }];
      }

      return [
        { type: 'nodeSection', nodeId, section: 'agents' },
        { type: 'nodeSection', nodeId, section: 'protocols' },
        { type: 'nodeSection', nodeId, section: 'routing' },
      ];
    }

    if (element.type === 'nodeSection') {
      const cached = this.nodeInspectCache.get(element.nodeId);
      if (!cached) {
        return [{ type: 'empty', label: 'No data' }];
      }

      const d = cached.data;

      if (element.section === 'agents') {
        if (d.agents.length === 0) return [{ type: 'empty', label: '(none)' }];
        return d.agents.map(a => ({
          type: 'nodeAgent' as const,
          nodeId: element.nodeId,
          agent: a,
        }));
      }

      if (element.section === 'protocols') {
        if (d.protocols.length === 0) return [{ type: 'empty', label: '(none)' }];
        return d.protocols.map(p => ({
          type: 'nodeProtocol' as const,
          nodeId: element.nodeId,
          protocol: p,
        }));
      }

      if (element.section === 'routing') {
        const entries = Object.entries(d.routing);
        if (entries.length === 0) return [{ type: 'empty', label: '(empty)' }];
        return entries.map(([agentName, route]) => ({
          type: 'nodeRoute' as const,
          nodeId: element.nodeId,
          agentName,
          route,
        }));
      }
    }

    return [];
  }

  dispose(): void {
    this.disconnect();
    this._onDidChangeTreeData.dispose();
  }
}
