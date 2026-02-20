/**
 * RemoteNode — a standalone agent node process that connects to ROS via WsNodeLink.
 *
 * Creates its own ReagentController + NativeAgentNode, connects to ROS,
 * and receives deploy/trigger commands over the WsNodeLink.
 */

import { WebSocket } from "ws";
import { ReagentController } from "./reagent-controller.js";
import { NativeAgentNode } from "./native-agent-node.js";
import { WsNodeLink } from "./ws-node-link.js";
import type { IRGraph, RoleIR, TraceEvent, MessageEnvelope } from "./types.js";
import type { TraceHook } from "./interceptor.js";

export interface RemoteNodeConfig {
  nodeId: string;
  rosUrl: string;
  supportedLangs?: string[];
}

/**
 * A remote agent node that connects to the ROS via WebSocket.
 * It registers itself, receives deploy commands, and routes messages.
 */
export class RemoteNode {
  readonly nodeId: string;
  private rosUrl: string;
  private rc: ReagentController;
  private ws: WebSocket | null = null;
  private link: WsNodeLink | null = null;
  private roleToAgent: Record<string, string> = {};
  private traceHook: TraceHook;
  private supportedLangs: string[];

  constructor(config: RemoteNodeConfig) {
    this.nodeId = config.nodeId;
    this.rosUrl = config.rosUrl;
    this.supportedLangs = config.supportedLangs ?? ["ts"];

    this.traceHook = (event: TraceEvent) => {
      this.sendControl("TraceEvent", event as unknown as Record<string, unknown>);
    };

    const tsNode = new NativeAgentNode({
      roleToAgent: this.roleToAgent,
      traceHook: this.traceHook,
    });

    const agentNodes: Record<string, NativeAgentNode> = {};
    for (const lang of this.supportedLangs) agentNodes[lang] = tsNode;

    this.rc = new ReagentController({
      nodeId: this.nodeId,
      agentNodes,
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.rosUrl);
      this.ws.on("open", () => {
        // Send handshake
        this.ws!.send(JSON.stringify({ nodeId: this.nodeId }));

        // Create WsNodeLink for envelope routing
        this.link = new WsNodeLink({
          remoteNodeId: "ros",
          role: "client",
        });

        // The link is backed by a separate WS message channel for envelopes.
        // For simplicity, we multiplex control and envelope messages on the same WS.
        // Control messages have a "rap" field; envelopes have "from"/"to" fields.
        this.ws!.on("message", (data) => {
          const raw = data.toString();
          try {
            const msg = JSON.parse(raw);
            if (msg.rap) {
              this.handleControlMessage(msg);
            } else if (msg.from && msg.to) {
              // It's an envelope — dispatch to local agents
              this.rc.getAgent(msg.to.agent)?.dispatchMessage(msg as MessageEnvelope);
            }
          } catch { /* ignore */ }
        });

        resolve();
      });
      this.ws.on("error", reject);
    });
  }

  async close(): Promise<void> {
    await this.rc.stop();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  getController(): ReagentController {
    return this.rc;
  }

  private sendControl(rap: string, payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ rap, payload, nodeId: this.nodeId }));
    }
  }

  private handleControlMessage(msg: { rap: string; payload?: Record<string, unknown> }): void {
    switch (msg.rap) {
      case "Deploy":
        this.handleDeploy(msg.payload ?? {});
        break;
      case "TriggerProtocol":
        this.handleTrigger(msg.payload ?? {});
        break;
      default:
        break;
    }
  }

  private handleDeploy(payload: Record<string, unknown>): void {
    const agentName = payload.agentName as string;
    const roleIR = payload.roleIR as unknown as RoleIR;
    const graphs = new Map<string, IRGraph>();

    const graphsObj = payload.graphs as Record<string, unknown> | undefined;
    if (graphsObj) {
      for (const [key, graph] of Object.entries(graphsObj)) {
        graphs.set(key, graph as IRGraph);
      }
    }

    const rta = payload.roleToAgent as Record<string, string> | undefined;
    if (rta) {
      Object.assign(this.roleToAgent, rta);
    }

    this.rc.registerAgent(agentName, roleIR, graphs);
    this.sendControl("Deployed", { agentName, nodeId: this.nodeId });
  }

  private handleTrigger(payload: Record<string, unknown>): void {
    const agentName = payload.agentName as string;
    const raw = payload.trigger as Record<string, unknown>;
    this.rc.triggerProtocol(agentName, {
      instanceId: raw.instanceId as string,
      protocolName: raw.protocolName as string,
      input: (raw.input as Record<string, unknown>) ?? {},
      roleToAgent: (raw.roleToAgent as Record<string, string>) ?? this.roleToAgent,
    });
  }
}
