import assert from "node:assert/strict";

import { parseProgram } from "../../../../lang/src/parser.js";
import { emitIR, emitMessageSchema, emitRoleIR, resetIdCounter } from "../../../../lang/src/ir-emitter.js";
import type { AgentDef, MessageDef, ProtocolDef, RoleDef } from "../../../../lang/src/ast.js";
import type { IRGraph, IRMessageSchema, RoleIR } from "../../../../lang/src/ir.js";

export type CompiledSource = {
  protocols: ProtocolDef[];
  roles: RoleDef[];
  agents: AgentDef[];
  messages: MessageDef[];
  roleMap: Map<string, RoleDef>;
  graphsByProtocol: Map<string, Map<string, IRGraph>>;
  graphs: Map<string, IRGraph>;
  schemas: IRMessageSchema[];
  roleResults: Map<string, ReturnType<typeof emitRoleIR>>;
  roleIRs: Map<string, RoleIR>;
};

export function compileSource(src: string): CompiledSource {
  const res = parseProgram(src);
  assert.ok(res.ok, `Parse failed: ${res.errors.map((error) => error.message).join(", ")}`);

  const protocols = res.ast.items.filter((item): item is ProtocolDef => item.kind === "ProtocolDef");
  const roles = res.ast.items.filter((item): item is RoleDef => item.kind === "RoleDef");
  const agents = res.ast.items.filter((item): item is AgentDef => item.kind === "AgentDef");
  const messages = res.ast.items.filter((item): item is MessageDef => item.kind === "MessageDef");

  const roleMap = new Map<string, RoleDef>();
  for (const role of roles) {
    roleMap.set(role.name, role);
  }

  const graphsByProtocol = new Map<string, Map<string, IRGraph>>();
  const graphs = new Map<string, IRGraph>();
  for (const protocol of protocols) {
    resetIdCounter();
    const result = emitIR(protocol);
    assert.ok(result.ok, `IR emit failed for ${protocol.name}: ${result.errors.join(", ")}`);
    graphsByProtocol.set(protocol.name, result.graphs);
    for (const [role, graph] of result.graphs) {
      graphs.set(`${protocol.name}.${role}`, graph);
    }
  }

  const schemas = messages.map((message) => emitMessageSchema(message));

  const roleResults = new Map<string, ReturnType<typeof emitRoleIR>>();
  const roleIRs = new Map<string, RoleIR>();
  for (const role of roles) {
    const result = emitRoleIR(role, roleMap);
    assert.ok(result.ok, `Role IR emit failed for ${role.name}: ${result.errors.join(", ")}`);
    roleResults.set(role.name, result);
    roleIRs.set(role.name, result.roleIR);
  }

  return {
    protocols,
    roles,
    agents,
    messages,
    roleMap,
    graphsByProtocol,
    graphs,
    schemas,
    roleResults,
    roleIRs,
  };
}
