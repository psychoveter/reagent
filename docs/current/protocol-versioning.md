# Protocol Versioning, Agent Model, and Deployment Architecture

Design document for Reagent M8.

Status: **All phases DONE (M8a + M8b)** | Author: Oleg Bukhvalov | Date: 2026-02-20

---

## 1. Problem statement

Reagent has no concept of protocol version. This blocks hot deployment, runtime
introspection, and cross-node compatibility checking.

Four concrete problems:

**No identity for compiled protocols.** Two compilations of the same `.rg` file
produce byte-identical IR, but there is no fingerprint to prove it, and no
version to track changes over time. A changed protocol cannot be distinguished
from the original.

**RC has no knowledge plane.** `ReagentController` is a message router. It
stores `agents: Map<string, AgentHandle>` and a routing table, but discards
`IRGraph` and `RoleIR` after `registerAgent()`. It cannot answer "which
protocols are deployed on this node?" or "is this new protocol compatible with
what's already running?"

**Agent model is thin.** An agent is a role instance with no native code and no
composability:

```
agent Alice runs GreeterRole     # .rg file
  → AgentIR { name, lang, roleName, roleFile }    # 4 fields
  → AgentRunner wrapping RoleIR                    # runtime
```

There is no place for user-defined host-language logic beyond zone bodies, and
no way to compose an agent from roles defined in different `.rg` files.

**`deployment.json` mixes concerns.** The compiler output doubles as a
deployment manifest: it contains both a file index (which `.ir.json` was
generated) and deployment decisions (`roleToAgent` mapping). These are
compilation vs. orchestration concerns.

---

## 2. Three-world separation

The architecture splits into three distinct planes:

```
 Compilation              Cluster State            Desired State
 (stateless)              (Beliefs)                (Intentions)
 ───────────              ─────────────            ─────────────
 .rg source       ───►    RC protocol registry     DeploySpec
 ↓ reagent compile        (what IS deployed)       (what SHOULD be)
 IR artifacts                     ▲                      │
 (*.ir.json,                      │                      ▼
  *.role.json)              ROS reconciler (§13)
```

**Compilation** takes `.rg` files and produces IR artifacts. It is stateless
and deterministic. The compiler knows nothing about clusters, nodes, or
deployments.

**Cluster state** is the actual state of each `ReagentController`. Each RC
knows which protocols it hosts, which agents are registered, and the version
and fingerprints of each. This is the "beliefs" layer -- the ground truth of
what is running.

**Desired state** describes the target configuration: which protocols should
run where, with which agents, on which nodes. This is the "intentions" layer.
The **ROS reconciler** (§13) compares desired state with cluster state and
acts to bring them into alignment.

### Consequences

- The compiler does **not** produce deployment plans.
- `deployment.json` will evolve into a build index (list of generated files)
  rather than a deployment manifest.
- Version and fingerprint data lives **inside** IR files (`*.ir.json`,
  `*.role.json`), not in a separate manifest.
- RC becomes the authoritative registry of deployed protocols.

---

## 3. Protocol fingerprints

Each compiled protocol carries three independent SHA-256 hashes.

### 3.1 Structure hash (choreography)

Captures the topology of the protocol state machine.

Input (for each role graph, sorted alphabetically by role name):
- BFS traversal from `initialStateId`
- For each state visited: `(kind, messageName?, to/from?, arrow?, guardExpr?, duration?, invokeTarget?, branchCount?)`
- For each transition: `(fromIndex, toIndex, labelKind, labelValue?)`

Normalization rules:
- State IDs are replaced with BFS-order indices (0, 1, 2...).
  The compiler uses a global counter for IDs (`send_1`, `recv_2`) which is
  deterministic for a given source file but semantically meaningless.
- Role graphs are sorted alphabetically by role name.
- Only structural properties are included; zone bodies are excluded.

When `structureHash` changes, the choreography is different. Agents compiled
against the old version cannot interoperate with agents compiled against the
new version -- their state machines expect different message sequences.

### 3.2 Schema hash (data contract)

Captures the message type definitions referenced by the protocol.

Input:
- All `IRMessageSchema` entries whose `name` appears in any send/receive state
  of the protocol.
- For each schema, sorted by name: `(name, [field sorted by name: (fieldName, typeJSON, optional)])`.

When `schemaHash` changes, the payload shape is different. This may or may not
break compatibility depending on the nature of the change (additive vs.
removing).

### 3.3 Implementation hash (zone code)

Captures the opaque host-language code.

Input:
- All zone bodies: `action.body`, `preSendZone`, `postReceiveZone`.
- All guard expressions (`expr` fields).
- Each body is whitespace-normalized (trim, collapse internal whitespace).
- Bodies are ordered by BFS traversal order within each graph, roles sorted
  alphabetically.

When only `implHash` changes, the protocol choreography and data contract are
the same, but the code within zones is different.

### 3.4 Type definitions

```typescript
type ProtocolFingerprint = {
  structureHash: string;   // SHA-256 hex
  schemaHash: string;      // SHA-256 hex
  implHash: string;        // SHA-256 hex
};
```

These fields are added to `IRGraph` (stored inside each `*.ir.json` file).

---

## 4. Role fingerprints

Each compiled role carries two independent SHA-256 hashes.

### 4.1 Plays hash

Captures which protocols the role participates in.

Input:
- `plays` bindings sorted by `(protocolName, roleName)`.
- Each binding includes the **protocol version** at compile time.

### 4.2 Behavior hash

Captures the role's implementation code.

Input:
- `initAction?.body` (whitespace-normalized).
- Lifecycle handlers sorted by `(event, protocolFilter)`: `(event, protocolFilter, body)`.
- `lang` tag.

### 4.3 Type definitions

```typescript
type RoleFingerprint = {
  playsHash: string;       // SHA-256 hex
  behaviorHash: string;    // SHA-256 hex
};
```

These fields are added to `RoleIR` (stored inside each `*.role.json` file).

---

## 5. Auto-semver

Protocol and role versions are computed automatically by the compiler. Users
do not specify versions manually.

### 5.1 Algorithm

The compiler reads the previous fingerprints and versions from
`reagent.lock` (if it exists in the project root). This file is committed
to version control, ensuring deterministic versioning across developers
and CI environments. The compiler does NOT rely on `outDir` contents
(which are typically gitignored and absent on CI).

For each protocol, it compares fingerprints:

| Change                                     | Bump    | Meaning                              |
|--------------------------------------------|---------|--------------------------------------|
| `structureHash` differs                    | MAJOR   | Choreography changed (breaking)      |
| `schemaHash` differs (structure unchanged) | MINOR   | Data contract changed (may break)    |
| `implHash` differs (both unchanged)        | PATCH   | Code changed (non-breaking shape)    |
| Nothing changed                            | None    | Same version                         |

First compilation (no previous output): version `1.0.0`.

The same logic applies to roles with their two-hash model:
- `playsHash` differs: MAJOR (role participates in different protocols).
- `behaviorHash` differs: MINOR (init/lifecycle code changed).

### 5.2 Version storage

The version string is stored inside the IR artifact itself:

```json
// Greet.greeter.ir.json
{
  "protocolName": "Greet",
  "role": "greeter",
  "version": "1.2.3",
  "fingerprints": {
    "structureHash": "a1b2c3...",
    "schemaHash": "d4e5f6...",
    "implHash": "789abc..."
  },
  ...
}
```

```json
// GreeterRole.role.json
{
  "roleName": "GreeterRole",
  "version": "1.0.1",
  "fingerprints": {
    "playsHash": "...",
    "behaviorHash": "..."
  },
  ...
}
```

Additionally, the compiler writes/updates `reagent.lock` with the latest
fingerprints and versions for all protocols and roles:

```json
// reagent.lock (committed to VCS)
{
  "protocols": {
    "Greet": {
      "version": "1.2.3",
      "fingerprints": {
        "structureHash": "a1b2c3...",
        "schemaHash": "d4e5f6...",
        "implHash": "789abc..."
      }
    }
  },
  "roles": {
    "GreeterRole": {
      "version": "1.0.1",
      "fingerprints": {
        "playsHash": "...",
        "behaviorHash": "..."
      }
    }
  }
}
```

This ensures:
- **CI determinism**: fresh clone with empty `outDir` still gets correct
  version bumps by reading `reagent.lock`.
- **Cross-developer consistency**: two developers get the same version for
  the same source, because both read the same committed lock file.
- **Standalone compile**: `reagent compile <file>` (no project context)
  starts at `1.0.0` if no lock file exists — backward compatible.

---

## 6. Dependency tracking

When protocol A contains `invoke B` or `spawn B`, A has a compile-time
dependency on B. The compiler records:

```typescript
type ProtocolDependency = {
  protocolName: string;
  structureHash: string;   // expected choreography of dependency
  version: string;         // version at compile time
};
```

This is stored in the `IRGraph` under a new `dependencies` field.

At deploy time, the RC checks: does the currently registered version of B
have a `structureHash` matching what A expects? If not, A cannot be deployed
because its expectations of B's choreography do not match reality.

---

## 7. IR type extensions

### 7.1 IRGraph (lang/src/ir.ts)

New optional fields (backward compatible with existing compiled output):

```typescript
type IRGraph = {
  protocolName: string;
  role: string;
  lang: LangTag;
  version?: string;                          // auto-semver
  fingerprints?: ProtocolFingerprint;        // three hashes
  dependencies?: ProtocolDependency[];       // invoke/spawn deps
  initiator?: string;                        // for decompiler round-trip
  inputMessageName?: string;                 // for decompiler round-trip
  states: IRState[];
  transitions: IRTransition[];
  initialStateId: string;
  terminalStateIds: string[];
};
```

### 7.2 RoleIR (lang/src/ir.ts)

New optional fields:

```typescript
type RoleIR = {
  roleName: string;
  lang?: LangTag;
  version?: string;                          // auto-semver
  fingerprints?: RoleFingerprint;            // two hashes
  extends?: string;
  plays: AgentPlaysBinding[];
  initAction?: AgentAction;
  lifecycleHandlers: AgentLifecycleHandler[];
};
```

### 7.3 Runtime mirrors (runtime/ts/src/types.ts)

The runtime type duplicates are extended with the same optional fields. Old
compiled output lacking these fields continues to work.

### 7.4 MessageEnvelope and ProtocolTrigger

Add optional `protocolVersion?: string` so nodes can verify version
compatibility at message routing time.

---

## 8. RC protocol registry

`ReagentController` gains a registry that tracks protocols, roles, and their
relationship to agents.

### 8.1 Registry data model

```typescript
interface ProtocolEntry {
  name: string;
  version: string;
  fingerprints: ProtocolFingerprint;
  dependencies: ProtocolDependency[];
  irGraphs: Map<string, IRGraph>;         // role name -> graph
  registeredAt: number;                    // timestamp
}

interface RoleEntry {
  name: string;
  version: string;
  fingerprints: RoleFingerprint;
  roleIR: RoleIR;
}
```

### 8.2 ReagentController additions

```typescript
class ReagentController {
  readonly registry: ProtocolRegistry;    // new, public for tooling

  registerProtocol(entry: ProtocolEntry): void;
  getProtocol(name: string): ProtocolEntry | undefined;
  listProtocols(): ProtocolEntry[];

  canDeploy(newEntry: ProtocolEntry): CompatibilityReport;
}
```

`registerAgent()` is modified to also populate the registry:
1. Extract protocol names from the `graphs` keys.
2. Update the reverse index (protocol -> agents).
3. Store `roleIR` and `graphs` in the registry (if not already registered via
   `registerProtocol()`).

### 8.3 Compatibility checking

```typescript
interface CompatibilityReport {
  compatible: boolean;
  changeLevel: "none" | "patch" | "minor" | "major";
  details: string[];
  requiresAgentRestart: boolean;
  affectedAgents: string[];
  dependencyConflicts: Array<{
    depName: string;
    expectedStructureHash: string;
    actualStructureHash: string;
  }>;
}
```

`canDeploy()` logic:
1. Protocol not in registry: compatible, changeLevel `"none"` (new protocol).
2. `structureHash` differs: changeLevel `"major"`, `requiresAgentRestart: true`.
3. `schemaHash` differs: changeLevel `"minor"`.
4. `implHash` differs: changeLevel `"patch"`.
5. Each dependency: find in registry, compare `structureHash`, report conflicts.

### 8.4 Tooling access

The registry is public (`rc.registry`). Tooling can connect to an RC (via RAP
or in-process) and query:
- What protocols are deployed?
- What version of protocol X is running?
- Is my new version compatible?
- Which agents play roles in protocol X?

---

## 9. Agent model evolution

### 9.1 Current model

An agent in Reagent today is a thin deployment binding:

```
.rg:     agent Alice runs GreeterRole
AgentIR: { agentName, lang, roleName, roleFile }   # 4 fields
Runtime: AgentRunner(agentIR, graphs, transport)    # wraps RoleIR
```

All behavior comes from the `RoleIR`. The agent adds nothing of its own beyond
a name and a language tag. Zone bodies within protocols reference functions
(`taskToDsiBsi(...)`, `compensate(...)`) that must somehow be available in the
zone execution scope, but there is no mechanism to provide them.

### 9.2 Problem

- No native code attachment. Zones execute via `new Function()` with injected
  `$ctx`, `$self`, `reagent`. Host-language functions must be
  injected via `extras` (exists in `executeZone()` but never wired through the
  runtime stack).
- No composability. An agent runs exactly one role. Roles can `plays` multiple
  protocols, but all must be visible in a single `.rg` file.
- Two conflicting use-cases:
  - **Overlay**: Reagent coordinates existing services. Agents are thin
    adapters to company APIs.
  - **Native**: Reagent is the application framework (Cognos). Agents are
    rich entities with state, persistence, and domain logic.

### 9.3 Agent model — `$agent` binding (implemented, M8b Phase 3)

An agent gains a host-language extension point via `agent.json`. The native
module's default export is injected into every zone scope as `$agent`:

```
agents/alice/agent.json    # manifest: role, native module, config
agents/alice/impl.ts       # host-language code

impl.ts:
  export default class Alice extends ReagentAgent {
    private db: Database;
    async onInit() { this.db = await connect(this.config.dbUrl); }
    async queryUser(id: string) { return this.db.findUser(id); }
  }
```

Zone bodies access native methods via `$agent`:

```rg
greeter {
  $ctx.msg.user = await $agent.queryUser($ctx.userId)
}
```

**Implementation status**: fully implemented in M8b Phase 3. The `extras`
parameter is wired through the entire runtime stack in both TS and Python:
`AgentNode` → `AgentRunner` → `ProtocolInstance` → zone executor. Async
zones (detected by `await` in zone body at compile time) use
`executeZoneAsync` (TS: `AsyncFunction`, Python: `async def` wrapper).
E2E tests A1–A6 validate `$agent` binding, async zones, and `agent.json`
manifests. See lang-spec.md §1.3.1 for the language-level specification.

**`agent` keyword in `.rg` remains but is optional.** If `agent.json`
exists for an agent, it takes priority (native module, config). If no
`agent.json` exists, the `.rg` `agent X runs Role` declaration works exactly
as before — backward compatible. This preserves the existing pipeline:
29 examples, compiler, deployment.json `roleToAgent`, ROS, E2E tests,
RunController, TextMate grammar — all unchanged.

The `.rg` language continues to describe protocols, roles, messages, and
(optionally) agents. `agent.json` is an extension mechanism for native code,
not a replacement for `.rg` agent declarations.

### 9.4 Agent manifest (`agent.json`)

```json
{
  "name": "Alice",
  "lang": "ts",
  "role": "AliceRole",
  "module": "./impl.ts",
  "config": {
    "dbUrl": "${DB_URL}"
  }
}
```

- `role`: single role name this agent materializes. Matches the `.rg`
  `agent Alice runs AliceRole` declaration. If an agent needs to play
  multiple protocols, use `role extends` in `.rg` to create a composite
  role (M4-LANG already supports this). This avoids a second composition
  mechanism that would conflict with `extends`.
- `module`: path to host-language module exporting the agent class/object.
  The runtime `require()`s or `import()`s this module and uses its exports
  as the `$agent` binding in zones.
- `config`: key-value pairs, supports environment variable interpolation.

**Why single role, not a list?** M4-LANG introduced `role extends` for
composing multi-protocol roles via inheritance (merged plays, init, lifecycle
handlers). Adding a flat `roles: [...]` array in `agent.json` would create a
second, conflicting composition mechanism with unresolved semantics (handler
conflicts, init ordering, extends chain across roles). Keeping `agent.json` →
one role keeps composition in the language where it belongs.

### 9.5 Overlay vs. native modes

**Overlay mode** (adapting existing infrastructure):
- Agent module wraps company API clients.
- Zones call `$agent.callService(...)`, `$agent.publishEvent(...)`.
- Protocols describe the coordination contract between existing services.
- Minimal Reagent footprint: RC + agents as bridges.

**Native mode** (Reagent-first, e.g. Cognos):
- Agents are standalone entities managed entirely by RC.
- Native module contains domain logic, state persistence, ML models.
- RC manages agent lifecycle, scaling, placement.
- Full Reagent ecosystem: project structure, dependency management, deploy
  tool.

Both modes use the same agent manifest and runtime infrastructure. The
difference is in what the native module does.

### 9.6 Runtime prerequisites for $agent

The `extras` parameter already exists in `executeZone()` but is not wired
through the runtime stack. The threading path:

1. `NativeAgentNodeConfig` gains `extras?: Record<string, unknown>`.
2. `NativeAgentNode.createAgent()` passes extras to `AgentRunnerConfig`.
3. `AgentRunner` passes extras to each `ProtocolInstance`.
4. `ProtocolInstance` passes extras to every `executeZone()` call.

For the `$agent` binding specifically: when an agent has a native module, the
module's exports are injected as `extras: { $agent: moduleInstance }`. The
zone body can then call `$agent.methodName(...)`.

**Async zones** (needed for `await $agent.queryUser(...)`) use a separate
code path — `executeZoneAsync()` — rather than replacing the existing sync
`executeZone()`. The compiler detects `await` in zone bodies at compile time
and marks the IR state with `async: true`. The runtime dispatches accordingly:

```typescript
// Compile-time: ir-emitter.ts
if (zoneBody.includes('await ')) {
  state.async = true;
}

// Runtime: protocol-instance.ts handleAction()
if (state.async) {
  result = await executeZoneAsync(body, ctx, self, flow, extras);
} else {
  result = executeZone(body, ctx, self, flow, extras);  // existing sync path
}
```

```typescript
// zone-executor.ts
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

function executeZoneAsync(body, ctx, self, extras) {
  const fn = new AsyncFunction('$ctx', '$self', 'reagent', '$agent', body);
  return fn(ctx, self, reagent, extras?.$agent);
}
```

This is backward compatible: zones without `await` use the existing sync
path. BranchRunner (par/scatter), DebugAdvanceHook, and Python runtime
(`exec()` + `asyncio.run()`) are unaffected for sync zones.

For Python, async zones use `compile()` + `exec()` with an `async def`
wrapper and `asyncio.run()`.

---

## 10. Reagent project structure

A Reagent project is the unit of organization, analogous to an npm package or
Rust crate.

```
my-project/
├── reagent.json              # project manifest
├── protocols/
│   ├── greet.rg              # protocol + role + message definitions
│   └── task-flow.rg
├── agents/
│   ├── alice/
│   │   ├── agent.json        # agent manifest
│   │   └── impl.ts           # native code
│   └── bob/
│       ├── agent.json
│       └── impl.py
└── out/                      # compiled IR (gitignored)
    ├── Greet.greeter.ir.json
    ├── Greet.responder.ir.json
    ├── GreeterRole.role.json
    ├── ResponderRole.role.json
    └── messages.json
```

### 10.1 `reagent.json` (project manifest)

```json
{
  "name": "my-project",
  "version": "0.1.0",
  "protocols": ["protocols/*.rg"],
  "agents": ["agents/*/agent.json"],
  "dependencies": {
    "@company/auth-protocol": "^1.0.0"
  }
}
```

- `protocols`: glob patterns for `.rg` source files.
- `agents`: glob patterns for agent manifests.
- `dependencies`: other Reagent packages providing protocols/roles.

### 10.2 Import resolution

The `.rg` language already has file-level `import "path/to/file.rg"`
(lang-spec §1.17). The `reagent.json` `dependencies` field bridges
package-level dependencies to file-level imports. Resolution algorithm
(analogous to Node.js `node_modules` or `tsconfig.json` paths):

1. **Relative import** (`import "./auth.rg"`, `import "../common/types.rg"`):
   resolved relative to the importing file. No change.

2. **Package import** (`import "@company/auth-protocol/greet.rg"`):
   - Strip the package name prefix (e.g., `@company/auth-protocol`).
   - Look up the package in `reagent.json` dependencies.
   - Resolve the package root: `reagent_packages/@company/auth-protocol/`
     (installed by `reagent install`, analogous to `node_modules`).
   - Append the remainder path: `reagent_packages/@company/auth-protocol/greet.rg`.

3. **Bare name import** (`import "auth-protocol"`): resolves to the
   package's main entry point (defined in the dependency's own `reagent.json`
   `main` field, default: `protocols/index.rg`).

The parser doesn't need to know about `reagent.json` — resolution happens in
the compiler CLI (`reagent build`) which passes resolved file paths to the
parser. For standalone `reagent compile <file>`, only relative imports work
(no package resolution). Package resolution requires `reagent build` with a
project context.

**`reagent install`** (future): downloads dependencies into
`reagent_packages/`, creates a `reagent.lock` with resolved versions and
fingerprint checksums.

### 10.3 Relationship to `deployment.json`

`deployment.json` currently serves as both build index and deployment plan.
Under the new model:

- **Build index** remains as a convenience: list of generated files with paths.
  Generated by the compiler, consumed by tooling for navigation.
- **Deployment plan** moves to a separate concern: desired-state specification
  describing which agents should run on which nodes. This will be consumed
  by a future deploy tool or ROS reconciler.

The current `deployment.json` format is preserved for backward compatibility
with existing ROS and test infrastructure. `roleToAgent` continues to work as
before. The new fields (`version`, `fingerprints`) live inside individual IR
files rather than in `deployment.json`.

---

## 11. IR decompiler

Tooling that connects to an RC needs to show users what protocols are running.
Since the RC stores IR (not source), an IR-to-`.rg` decompiler is needed.

### 11.1 Single-role view

Walks one `IRGraph` via BFS and emits pseudo-`.rg` showing that role's
perspective.

Pattern detection:
- Fork -> branch transitions -> Join = `par { ... } and { ... }`
- XOR guard -> branches -> merge = `alt (...) { ... } else { ... }`
- Guard with back-edge = `loop (expr) { ... }`
- Error edge = `try { ... } catch label { ... }`

### 11.2 Multi-role merge

Loads all role graphs for a protocol and reconstructs the global choreography
by correlating send/receive pairs across roles.

Uses the new `initiator` field on `IRGraph` for the `initiator:` line.
Reconstructs `participants:` from the role set and lang tags.

### 11.3 What cannot be recovered

- Comments (stripped by parser).
- Original formatting and whitespace.
- Import statements (not stored in IR).
- Original declaration order of protocols, roles, agents, messages.

The output is **semantically equivalent** but not textually identical to the
original source. Re-compiling the decompiled output produces IR with identical
fingerprints.

### 11.4 CLI command

```
reagent decompile <dir>              # all protocols in compiled output dir
reagent decompile <file.ir.json>     # single role view
```

---

## 12. Migration path

M8 is split into two sub-milestones to avoid blocking M9-DX on breaking
changes that aren't needed for developer tooling:

- **M8a** (non-breaking): Phases 1, 2, 4 — fingerprints, registry, project
  structure, decompiler. Unblocks M9-DX.
- **M8b** (additive): Phases 3, 5 — agent model evolution, ROS reconciler.
  All opt-in: `agent` keyword stays, async zones are a separate path,
  reconciler coexists with session mode. Needed for Cognos/overlay,
  production deployment.

### Phase 1: Fingerprints in IR (non-breaking) — M8a ✅ DONE

- ✅ `ProtocolFingerprint`, `RoleFingerprint`, `ProtocolDependency` types in
  `lang/src/ir.ts` (optional fields on `IRGraph` and `RoleIR`).
- ✅ `lang/src/ir-fingerprint.ts` — pure functions: BFS traversal,
  state/transition canonicalization, whitespace normalization, SHA-256 hashing.
  Also extracts used message names and protocol dependencies.
- ✅ `lang/src/versioning.ts` — `reagent.lock` I/O (JSON), auto-semver logic:
  `classifyProtocolChange()`, `classifyRoleChange()`, `bumpVersion()`.
  Structure → MAJOR, schema → MINOR, impl → PATCH. First compile = 1.0.0.
- ✅ Integrated into `cli.ts cmdCompile` (not `ir-emitter.ts`): fingerprints
  are computed post-emit, versions resolved from `reagent.lock`, lock updated.
- ✅ Types mirrored in `runtime/ts/src/types.ts` (all optional).
- ✅ Python: `runtime/py/reagent_runtime/ir_fingerprint.py` — read-only
  extraction of fingerprints/versions/dependencies from IR JSON dicts.
- ✅ All functions exported from `lang/src/index.ts`.
- ✅ E2E tests F1–F6 passing.

**Implementation note**: fingerprint computation happens in `cli.ts` after
all IR graphs and message schemas are emitted, not inside the emitter itself.
This keeps the emitter pure (no crypto dependency) and allows cross-protocol
dependency resolution in a single pass.

### Phase 2: RC protocol registry (additive) — M8a ✅ DONE

- ✅ `runtime/ts/src/protocol-registry.ts` — `ProtocolRegistry` class with
  `register()`, `get()`, `list()`, `bindAgent()`, `agentsForProtocol()`,
  `canDeploy()` (change-level + dependency conflict detection).
- ✅ `registry: ProtocolRegistry` added to `ReagentController`, populated
  in `registerAgent()` with protocol-to-agent reverse index.
- ✅ `canDeploy()` returns `CompatibilityReport` with change level,
  `requiresAgentRestart`, and per-dependency conflict details.
- ✅ `protocolVersion` added to `MessageEnvelope` and `ProtocolTrigger`;
  `createMessageEnvelope()` accepts optional `protocolVersion`.
- ✅ Python mirror: `runtime/py/reagent_runtime/protocol_registry.py` with
  `ProtocolRegistry`, `can_deploy()`, dataclass-based entries. Wired into
  Python `ReagentController.register_agent()` and `list_protocols()`.
- ✅ E2E tests R1–R5 passing.

All existing code continues to work. The registry starts empty and is
populated as agents register. Fields on envelopes are optional.

### Phase 3: Agent model evolution (additive, not breaking) — M8b

- Wire `extras` through runtime stack (NativeAgentNode -> AgentRunner ->
  ProtocolInstance -> executeZone). TS and Python.
- Add `executeZoneAsync()` as a **separate path** (does not replace sync).
  Compiler marks states with `async: true` when zone body contains `await`.
  Runtime dispatches to sync or async executor accordingly.
- Python: async zones via `async def` wrapper + `asyncio.run()`.
- Define agent manifest format (`agent.json`) — single `role` field (not
  array). Multi-role composition via `role extends` in `.rg`.
- `agent` keyword in `.rg` remains but becomes optional. `agent.json` takes
  priority if present; otherwise `.rg` `agent X runs Role` works as before.
- Implement `$agent` binding injection from native module.

This phase is **additive** — existing examples and tests don't need changes.
The `agent` keyword is not removed. New features (agent.json, $agent binding,
async zones) are opt-in.

### Phase 4: Project structure and deploy tool — M8a

- Define `reagent.json` format with import resolution algorithm (§10.2).
- Implement `reagent init`, `reagent build` CLI commands.
- `reagent build` does package-level import resolution.
- Evolve `deployment.json` into build index.
- IR decompiler: single-role view, multi-role merge, `reagent decompile` CLI.

### Phase 5: ROS reconciler — M8b

- Extend ROS with `Reconciler`, `DeploySpec`, `RegistryView`.
- Implement convergence loop (plan → apply → verify).
- New RAP sub-protocols for reconciliation (10-14, see §13.6).
- `reagent deploy` CLI: submit deploy spec, wait for reconciliation.
- Python RC: implement `ListProtocols` RAP handler so Python nodes
  participate in reconciliation.

---

## 13. ROS as reconciliation controller

### 13.1 Motivation

ROS was designed in M6-RT as a session-based server: a client sends a `.rg`
file, ROS compiles it, deploys agents in-process, runs the protocol, and
supports debug stepping. This is the "interactive development" mode.

With M8's three-world separation (§2), a new role emerges: ROS is the natural
place for the **reconciler** — the component that compares desired state
(deploy spec) with actual state (RC registries) and drives convergence. This
is analogous to the Kubernetes API server (see Appendix B).

### 13.2 Two modes of operation

ROS operates in two non-exclusive modes:

**Session mode** (existing, unchanged):
- Client connects via WS, sends `Compile` → receives IR.
- Client sends `RunStart` / `DebugStart` → ROS deploys agents in-process,
  runs protocol, streams traces.
- Session lifetime: request → completion/disconnect.
- Used by: VSCode one-click Run/Debug, CLI `reagent run`.

**Reconciler mode** (new):
- ROS loads a `DeploySpec` (from `reagent.json` project + deploy plan, or
  via RAP `SubmitDeploySpec`).
- ROS periodically queries connected RC nodes for their registry state
  (`ListProtocols`, agent list).
- Reconciler computes diff and generates a `ReconciliationPlan`.
- ROS applies the plan: deploys protocols, upgrades versions, stops obsolete
  agents, creates new agents, redistributes load.
- Continuous: plan is re-evaluated on every state change (spec change, RC
  registry update, node connect/disconnect).
- Used by: `reagent deploy` CLI, VSCode topology view, production clusters.

Both modes coexist. A developer can Run/Debug a protocol in session mode while
the reconciler manages the broader cluster.

### 13.3 Desired state: `DeploySpec`

```typescript
interface DeploySpec {
  project: string;                  // from reagent.json
  protocols: DeployProtocolSpec[];
  nodes: DeployNodeSpec[];
}

interface DeployProtocolSpec {
  name: string;
  version: string;                  // required version (from compiled IR)
  fingerprints: ProtocolFingerprint;
  irArtifacts: string[];            // paths to *.ir.json files
  agents: DeployAgentSpec[];
}

interface DeployAgentSpec {
  name: string;
  manifest?: string;                // path to agent.json (optional — agents without native code don't need one)
  targetNode: string;               // nodeId where this agent should run
}

interface DeployNodeSpec {
  nodeId: string;
  host: string;
  runtime: "ts" | "py" | "ts-browser";
  type: "local" | "ssh" | "docker" | "browser" | "robot" | "sim";
  ssh?: { user: string; host: string; keyPath?: string };
}
```

`DeploySpec` is derived from:
- `reagent.json` — protocols and agents.
- A deploy plan file — node assignments, scaling, constraints.
- Or submitted dynamically via RAP.

### 13.4 Actual state: `RegistryView`

```typescript
interface RegistryView {
  nodes: NodeView[];
  lastUpdated: number;
}

interface NodeView {
  nodeId: string;
  connected: boolean;
  protocols: ProtocolEntry[];       // from RC registry
  agents: AgentEntry[];
  lastSeen: number;
}
```

ROS builds the `RegistryView` by querying each connected RC node via new RAP
sub-protocols (`ListProtocols`, `ListAgents`). Updated on:
- Node connect/disconnect (WS events).
- Periodic polling (configurable interval, default 10s).
- Push notifications from RC on registry changes (future optimization).

### 13.5 Reconciliation plan

```typescript
interface ReconciliationPlan {
  actions: ReconciliationAction[];
  timestamp: number;
}

type ReconciliationAction =
  | { kind: "deploy-protocol"; nodeId: string; protocol: string;
      version: string; irPaths: string[] }
  | { kind: "upgrade-protocol"; nodeId: string; protocol: string;
      fromVersion: string; toVersion: string; irPaths: string[] }
  | { kind: "create-agent"; nodeId: string; agentName: string;
      manifest: string }
  | { kind: "stop-agent"; nodeId: string; agentName: string;
      reason: string }
  | { kind: "no-op"; reason: string };
```

Reconciler algorithm:
1. For each protocol in `DeploySpec`, find matching entries in `RegistryView`.
2. **Missing**: protocol not in any target RC → action `deploy-protocol`.
3. **Version mismatch**: protocol exists but version differs → run
   `canDeploy()` remotely → action `upgrade-protocol` if compatible, else
   report conflict.
4. **Stale**: protocol in `RegistryView` but not in `DeploySpec` → action
   `stop-agent` for all agents playing that protocol.
5. **Agent placement**: agent on wrong node → action `stop-agent` + `create-agent`.
6. **Dependency ordering**: sort actions topologically (child protocols
   deployed before parents that invoke them, using `dependencies` from IR).

### 13.6 RAP extensions

New sub-protocols for reconciler ↔ RC communication:

| File | Protocol | Purpose |
|---|---|---|
| `tools/rap/10-list-protocols.rg` | ListProtocols | Query RC registry for deployed protocols + versions |
| `tools/rap/11-deploy-protocol.rg` | DeployProtocol | Deploy or upgrade a protocol on an RC. Includes IR artifacts, runs `canDeploy()` check |
| `tools/rap/12-cluster-status.rg` | ClusterStatus | Aggregated cluster state report (all nodes, protocols, agents) for tooling |
| `tools/rap/13-submit-deploy-spec.rg` | SubmitDeploySpec | Submit desired state to ROS, receive reconciliation result |
| `tools/rap/14-stop-agent.rg` | StopAgent | Graceful agent teardown on an RC |

### 13.7 `reagent deploy` CLI

```
reagent deploy [--plan deploy-plan.json] [--watch]
```

1. Reads `reagent.json` from current directory.
2. Compiles all protocols (if not already compiled).
3. Loads deploy plan (node assignments, or defaults to single local node).
4. Connects to ROS via WS.
5. Submits `DeploySpec`.
6. Waits for reconciliation to complete.
7. Reports result (deployed N protocols, upgraded M, stopped K agents).
8. `--watch`: re-submits on `.rg` file changes (live development loop).

---

## Appendix A: Analogy to shared-library ABI

| Shared library (SO/DLL)          | Reagent protocol                     |
|----------------------------------|--------------------------------------|
| Exported symbols (function names)| Message names + role names           |
| Function signatures (param types)| Message schemas (fields, types)      |
| Calling convention (cdecl, etc.) | Arrow kind (-->, ->, etc.)           |
| Struct layout (field offsets)    | $ctx shape contract                  |
| Function body (implementation)   | Zone bodies                          |
| ABI version                      | structureHash + schemaHash           |
| SO version (soname)              | Auto-semver version                  |

ABI compatibility = signatures unchanged, even if implementation differs.
Protocol compatibility = structure and schema hashes match, even if zone
bodies differ.

## Appendix B: Comparison to Kubernetes model

| Kubernetes                       | Reagent                              |
|----------------------------------|--------------------------------------|
| Container image                  | Compiled IR (*.ir.json)              |
| Dockerfile                       | .rg source file                      |
| Pod spec                         | Agent manifest (agent.json)          |
| Deployment (desired state)       | DeploySpec                           |
| kubelet (node agent)             | ReagentController (with registry)    |
| etcd (cluster state)             | RC protocol registries (distributed) |
| API server + controller manager  | ROS reconciler                       |
| kubectl apply                    | `reagent deploy`                     |
| Service (discovery)              | AddressPage / routing table          |
| Container registry               | Reagent package registry (future)    |
