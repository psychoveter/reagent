import * as vscode from 'vscode';
import { logDebugProtocol } from './debugLog';

interface RapMessage {
  rap: string;
  id?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

type RapListener = (msg: RapMessage) => void;

/**
 * WebSocket-based RAP client for communication with the Reagent Orchestrator Service.
 * Uses the built-in VS Code / Node.js WebSocket where available, falling back to ws.
 */
export class RapClient {
  private ws: import('ws') | null = null;
  private listeners = new Map<string, Set<RapListener>>();
  private wildcardListeners = new Set<RapListener>();
  private pendingRequests = new Map<string, {
    resolve: (msg: RapMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private reqCounter = 0;
  private _connected = false;
  private clusterMode = false;
  private runtimeApi: any = null;
  private adminClient: any = null;
  private resolver: any = null;
  private stateStoreProvider: any = null;
  private sessionClients = new Map<string, any>();

  constructor(private readonly url: string) {}

  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    if (this.url.startsWith('cluster://')) {
      this.clusterMode = true;
      const runtimeApi = await this.loadRuntimeApi();
      const config = this.getClusterConfig();
      this.stateStoreProvider = new runtimeApi.DirectStateStoreProvider(config);
      const store = await this.stateStoreProvider.getStateStore();
      this.resolver = new runtimeApi.StoreBackedNodeEndpointResolver(store);
      this.adminClient = new runtimeApi.AdminClient({
        stateStoreProvider: this.stateStoreProvider,
        nodeEndpointResolver: this.resolver,
      });
      this.runtimeApi = runtimeApi;
      this._connected = true;
      return;
    }

    const WebSocket = (await import('ws')).default;
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url) as import('ws');
      this.ws.on('open', () => {
        this._connected = true;
        resolve();
      });
      this.ws.on('error', (err: Error) => {
        if (!this._connected) reject(err);
      });
      this.ws.on('close', () => { this._connected = false; });
      this.ws.on('message', (data: import('ws').RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as RapMessage;
          this.dispatch(msg);
        } catch { /* ignore non-JSON */ }
      });
    });
  }

  close(): void {
    if (this.clusterMode) {
      for (const [, client] of this.sessionClients) {
        try {
          client.close();
        } catch { /* ignore */ }
      }
      this.sessionClients.clear();
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  send(msg: RapMessage): void {
    if (this.clusterMode) {
      void this.sendCluster(msg);
      return;
    }
    if (!this.ws || !this._connected) {
      throw new Error('RapClient not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send a request and wait for a specific response RAP type with the same id.
   */
  async request(rapType: string, payload: Record<string, unknown>, responseType: string, timeoutMs = 10000): Promise<RapMessage> {
    if (this.clusterMode) {
      const response = await this.requestCluster(rapType, payload);
      if (response.rap !== responseType && response.rap !== `${responseType}Failed` && response.rap !== 'DeployProjectFailed') {
        return response;
      }
      return response;
    }
    const id = `req-${++this.reqCounter}`;
    this.send({ rap: rapType, id, payload });

    return new Promise<RapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for ${responseType} (id=${id})`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  on(rapType: string, listener: RapListener): vscode.Disposable {
    if (!this.listeners.has(rapType)) {
      this.listeners.set(rapType, new Set());
    }
    this.listeners.get(rapType)!.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.get(rapType)?.delete(listener);
    });
  }

  onAny(listener: RapListener): vscode.Disposable {
    this.wildcardListeners.add(listener);
    return new vscode.Disposable(() => {
      this.wildcardListeners.delete(listener);
    });
  }

  private dispatch(msg: RapMessage): void {
    // Check pending request-response first
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const req = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      clearTimeout(req.timer);
      req.resolve(msg);
    }

    // Typed listeners
    if (msg.rap && this.listeners.has(msg.rap)) {
      for (const listener of this.listeners.get(msg.rap)!) {
        listener(msg);
      }
    }

    // Wildcard listeners
    for (const listener of this.wildcardListeners) {
      listener(msg);
    }
  }

  private async sendCluster(msg: RapMessage): Promise<void> {
    const response = await this.handleClusterMessage(msg);
    if (response) {
      this.dispatch(response);
    }
  }

  private async requestCluster(rapType: string, payload: Record<string, unknown>): Promise<RapMessage> {
    const response = await this.handleClusterMessage({
      rap: rapType,
      id: `req-${++this.reqCounter}`,
      payload,
    });
    if (!response) {
      throw new Error(`No response for ${rapType}`);
    }
    return response;
  }

  private async handleClusterMessage(msg: RapMessage): Promise<RapMessage | null> {
    if (!this.adminClient) {
      throw new Error('Cluster RapClient is not initialized');
    }
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    switch (msg.rap) {
      case 'ClusterStatus': {
        const response = await this.adminClient.clusterStatus();
        return { rap: 'ClusterStatusResponse', id: msg.id, payload: response.payload };
      }
      case 'NodeInspect': {
        const response = await this.adminClient.inspectNode(String(payload.nodeId ?? ''));
        return { rap: 'NodeInspectResult', id: msg.id, payload: response.payload };
      }
      case 'DeployProject': {
        const response = await this.adminClient.deployProject(payload as any);
        return { rap: response.rap, id: msg.id, payload: response.payload };
      }
      case 'TriggerOnCluster': {
        const agentName = String(payload.agentName ?? '');
        logDebugProtocol('rap.TriggerOnCluster.request', {
          agentName,
          protocolName: payload.protocolName,
          sessionId: payload.sessionId,
          breakpoints: payload.breakpoints,
          input: payload.input,
        });
        if ((payload.mode as string | undefined) === 'debug' && payload.sessionId) {
          await this.prepareClusterDebugSession(String(payload.sessionId), agentName);
        }
        const response = await this.adminClient.triggerProtocol(payload as any);
        logDebugProtocol('rap.TriggerOnCluster.response', {
          agentName,
          protocolName: payload.protocolName,
          sessionId: payload.sessionId,
          payload: response.payload,
        });
        return { rap: response.rap, id: msg.id, payload: response.payload };
      }
      case 'DebugCommand': {
        const sessionId = String(payload.sessionId ?? '');
        const client = this.sessionClients.get(sessionId);
        if (!client) {
          throw new Error(`No cluster debug session client for ${sessionId}`);
        }
        const debugPayload = await client.request('DebugCommand', payload);
        return { rap: 'DebugAck', id: msg.id, payload: debugPayload };
      }
      case 'SetBreakpointsRequest': {
        const sessionId = String(payload.sessionId ?? '');
        const client = this.sessionClients.get(sessionId);
        if (!client) {
          throw new Error(`No cluster debug session client for ${sessionId}`);
        }
        const breakpointsPayload = await client.request('SetBreakpointsRequest', payload);
        return { rap: 'BreakpointsResolved', id: msg.id, payload: breakpointsPayload };
      }
      case 'GetState': {
        const sessionId = String(payload.sessionId ?? '');
        const client = this.sessionClients.get(sessionId);
        if (!client) {
          throw new Error(`No cluster debug session client for ${sessionId}`);
        }
        const statePayload = await client.request('GetState', payload);
        return { rap: 'StateSnapshot', id: msg.id, payload: statePayload };
      }
      case 'GetDeployedIR': {
        const response = await this.adminClient.getDeployedIR(payload.protocolName as string | undefined);
        const nodes = (response.payload.nodes as Array<Record<string, unknown>>) ?? [];
        const first = nodes[0] ?? {};
        return {
          rap: 'DeployedIR',
          id: msg.id,
          payload: {
            protocolName: payload.protocolName,
            ...first,
          },
        };
      }
      default:
        throw new Error(`Unsupported cluster RAP message: ${msg.rap}`);
    }
  }

  private async prepareClusterDebugSession(sessionId: string, agentName: string): Promise<void> {
    if (this.sessionClients.has(sessionId)) return;
    const resolved = await this.resolver.resolveAgent(agentName);
    const client = new this.runtimeApi.NodeControlClient(resolved.endpoint.url);
    await client.connect();
    logDebugProtocol('rap.prepareClusterDebugSession.connected', {
      sessionId,
      agentName,
      endpoint: resolved.endpoint.url,
      nodeId: resolved.nodeId,
    });

    const disposers = [
      client.on('Stopped', (payload: Record<string, unknown>) => {
        logDebugProtocol('rap.nodeEvent.Stopped', {
          sessionId,
          payload,
        });
        this.dispatch({ rap: 'Stopped', payload });
      }),
      client.on('TraceEvent', (payload: Record<string, unknown>) => {
        const kind = String(payload.kind ?? '');
        if (kind === 'ActionStarted' || kind === 'ActionFinished' || kind === 'ProtocolFailed' || kind === 'ProtocolCompleted') {
          logDebugProtocol('rap.nodeEvent.TraceEvent', {
            sessionId,
            kind,
            stateId: payload.stateId,
            agentName: payload.agentName,
            role: payload.role,
            data: payload.data,
          });
        }
        this.dispatch({ rap: 'TraceEvent', payload });
      }),
      client.on('RunCompleted', (payload: Record<string, unknown>) => {
        this.dispatch({ rap: 'RunCompleted', payload });
      }),
      client.on('SourceMapUpdated', (payload: Record<string, unknown>) => {
        this.dispatch({ rap: 'SourceMapUpdated', payload });
      }),
    ];

    this.sessionClients.set(sessionId, {
      request: (op: string, payload: Record<string, unknown>) => client.request(op, payload),
      close: () => {
        for (const dispose of disposers) dispose();
        client.close();
      },
    });
  }

  private getClusterConfig(): { kind: 'memory' } | { kind: 'etcd'; hosts: string[] } {
    const config = vscode.workspace.getConfiguration('reagent.cluster');
    const stateStore = config.get<string>('stateStore') ?? 'etcd';
    if (stateStore === 'memory') {
      return { kind: 'memory' };
    }
    const hosts = config.get<string[]>('etcdHosts') ?? ['http://127.0.0.1:2379'];
    return { kind: 'etcd', hosts };
  }

  private async loadRuntimeApi(): Promise<any> {
    try {
      return require('../bundled/runtime-admin.cjs');
    } catch (err) {
      if (err instanceof Error) {
        throw new Error(`Cannot load packaged Reagent runtime admin API: ${err.message}`);
      }
      throw new Error(`Cannot load packaged Reagent runtime admin API: ${String(err)}`);
    }
  }
}
