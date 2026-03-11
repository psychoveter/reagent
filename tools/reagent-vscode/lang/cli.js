import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parseProgram } from "./parser.js";
import { emitIR, emitAgentIR, emitMessageSchema, emitRoleIR, resetIdCounter } from "./ir-emitter.js";
import { validateIRGraph } from "./ir-validator.js";
import { computeProtocolFingerprint, computeRoleFingerprint, extractUsedMessageNames, extractDependencies, } from "./ir-fingerprint.js";
import { readLock, writeLock, computeProtocolVersion, computeRoleVersion, } from "./versioning.js";
import { loadManifest, resolveGlobs, scaffoldProject, findProjectRoot } from "./project.js";
/**
 * Cross-protocol validation: every `invokes`/`async invokes` target
 * must have `trigger on invoke` in the target protocol.
 */
function validateInvocability(allGraphs) {
    const errors = [];
    const invocableSet = new Set();
    for (const [protoName, roleGraphs] of allGraphs) {
        const first = roleGraphs.values().next().value;
        if (first?.invocable)
            invocableSet.add(protoName);
    }
    for (const [protoName, roleGraphs] of allGraphs) {
        for (const [, graph] of roleGraphs) {
            for (const state of graph.states) {
                const d = state.data;
                if ((d.kind === "invoke" || d.kind === "async_invoke") && !invocableSet.has(d.protocolName)) {
                    errors.push(`Protocol "${protoName}" invokes "${d.protocolName}" which has no "trigger on invoke". ` +
                        `Add "trigger on invoke as <MsgType> { ... }" to protocol "${d.protocolName}".`);
                }
            }
        }
    }
    return errors;
}
function usage() {
    console.error("reagent-lang — Reagent compiler CLI\n");
    console.error("Commands:");
    console.error("  reagent-lang parse      <file.rg>                    — parse and print AST as JSON");
    console.error("  reagent-lang ir         <file.rg> [role]             — emit IR to stdout (optionally filter by role)");
    console.error("  reagent-lang validate   <file.rg> [role]             — emit IR, validate, print diagnostics");
    console.error("  reagent-lang compile    <file.rg> <out-dir>          — compile to IR JSON files");
    console.error("  reagent-lang init       [dir]                        — scaffold a new Reagent project");
    console.error("  reagent-lang build      [project-dir]                — build all protocols from reagent.json");
    console.error("  reagent-lang decompile  <dir|file.ir.json>           — reconstruct .rg from compiled IR");
    console.error("  reagent-lang verify     <file.rg>                    — generate TLA+ spec and check properties");
    console.error("  reagent-lang deploy     [project-dir] [ros-url]      — deploy protocols to ROS");
    console.error("");
    console.error("compile output:");
    console.error("  <out-dir>/<Proto>.<role>.ir.json   — per-role IR graph");
    console.error("  <out-dir>/<Role>.role.json         — per-role behavioral IR");
    console.error("  <out-dir>/<Agent>.agent.json       — per-agent deployment binding (references role)");
    console.error("  <out-dir>/deployment.json          — deployment plan (agent→role→graph mapping)");
    process.exit(2);
}
function parseFile(file) {
    const src = readFileSync(file, "utf8");
    const res = parseProgram(src);
    if (!res.ok) {
        console.error("Parse errors:");
        for (const e of res.errors) {
            console.error(`  [${e.code}] ${e.message} at ${e.loc.start.line}:${e.loc.start.col}`);
        }
        process.exit(1);
    }
    return res;
}
function getProtocols(res) {
    return res.ast.items.filter((i) => i.kind === "ProtocolDef");
}
function getAgents(res) {
    return res.ast.items.filter((i) => i.kind === "AgentDef");
}
function getMessages(res) {
    return res.ast.items.filter((i) => i.kind === "MessageDef");
}
function getRoles(res) {
    return res.ast.items.filter((i) => i.kind === "RoleDef");
}
function buildRoleMap(res) {
    const map = new Map();
    for (const r of getRoles(res))
        map.set(r.name, r);
    return map;
}
// ── parse ───────────────────────────────────────────────────────────
function cmdParse(file) {
    const res = parseFile(file);
    process.stdout.write(JSON.stringify(res.ast, null, 2) + "\n");
}
// ── ir ──────────────────────────────────────────────────────────────
function cmdIR(file, roleFilter) {
    const res = parseFile(file);
    const roleMap = buildRoleMap(res);
    for (const proto of getProtocols(res)) {
        resetIdCounter();
        const result = emitIR(proto);
        if (!result.ok) {
            console.error(`\nIR errors in protocol ${proto.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
        }
        for (const [role, graph] of result.graphs) {
            if (roleFilter && role !== roleFilter)
                continue;
            console.log(`\n=== ${proto.name} / ${role} ===`);
            console.log(JSON.stringify(graph, null, 2));
        }
    }
    for (const role of getRoles(res)) {
        const result = emitRoleIR(role, roleMap);
        if (!result.ok) {
            console.error(`\nRole IR errors in ${role.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
        }
        console.log(`\n=== role ${role.name} ===`);
        console.log(JSON.stringify(result.roleIR, null, 2));
    }
    for (const agent of getAgents(res)) {
        const result = emitAgentIR(agent, roleMap);
        if (!result.ok) {
            console.error(`\nAgent IR errors in ${agent.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
        }
        console.log(`\n=== agent ${agent.name} ===`);
        console.log(JSON.stringify(result.agentIR, null, 2));
    }
}
// ── validate ────────────────────────────────────────────────────────
function cmdValidate(file, roleFilter) {
    const res = parseFile(file);
    const roleMap = buildRoleMap(res);
    for (const proto of getProtocols(res)) {
        resetIdCounter();
        const result = emitIR(proto);
        if (!result.ok) {
            console.error(`\nIR emit errors in protocol ${proto.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
        }
        for (const [role, graph] of result.graphs) {
            if (roleFilter && role !== roleFilter)
                continue;
            const v = validateIRGraph(graph);
            console.log(`\n=== ${proto.name} / ${role} ===`);
            console.log(`  states: ${v.stats.stateCount}, transitions: ${v.stats.transitionCount}`);
            console.log(`  reachable: ${v.stats.reachableCount}, terminals: ${v.stats.terminalCount}`);
            if (v.ok) {
                console.log("  ✓ valid");
            }
            else {
                console.log("  ✗ errors:");
                for (const e of v.errors) {
                    console.log(`    [${e.code}] ${e.message}`);
                }
            }
        }
    }
    for (const role of getRoles(res)) {
        const result = emitRoleIR(role, roleMap);
        console.log(`\n=== role ${role.name} ===`);
        console.log(`  lang: ${role.lang ?? "none"}`);
        console.log(`  extends: ${role.extends ?? "none"}`);
        console.log(`  plays: ${result.roleIR.plays.length}`);
        console.log(`  init: ${result.roleIR.initAction ? "yes" : "no"}`);
        console.log(`  handlers: ${result.roleIR.lifecycleHandlers.length}`);
        if (result.ok) {
            console.log("  ✓ valid");
        }
        else {
            console.log("  ✗ errors:");
            for (const e of result.errors)
                console.log(`    ${e}`);
        }
    }
    for (const agent of getAgents(res)) {
        const result = emitAgentIR(agent, roleMap);
        console.log(`\n=== agent ${agent.name} ===`);
        console.log(`  runs: ${agent.runs}`);
        console.log(`  lang: ${result.agentIR.lang}`);
        console.log(`  roleFile: ${result.agentIR.roleFile}`);
        if (result.ok) {
            console.log("  ✓ valid");
        }
        else {
            console.log("  ✗ errors:");
            for (const e of result.errors)
                console.log(`    ${e}`);
        }
    }
}
// ── compile ─────────────────────────────────────────────────────────
function cmdCompile(file, outDir) {
    const res = parseFile(file);
    const protocols = getProtocols(res);
    const agents = getAgents(res);
    const roleMap = buildRoleMap(res);
    const roles = getRoles(res);
    outDir = resolve(outDir);
    mkdirSync(outDir, { recursive: true });
    let protoRoleCount = 0;
    let roleDefCount = 0;
    let agentCount = 0;
    let hasErrors = false;
    const allSourceMapEntries = [];
    // Lock file lives at the project root (reagent.json dir), or next to the source file
    const fileDir = dirname(resolve(file));
    const projectRoot = findProjectRoot(fileDir);
    const lockPath = join(projectRoot ?? fileDir, "reagent.lock");
    const lock = readLock(lockPath);
    const newLock = {
        protocols: { ...(lock?.protocols ?? {}) },
        roles: { ...(lock?.roles ?? {}) },
    };
    // Collect all emitted graphs per protocol for fingerprinting
    const protocolGraphs = new Map();
    // Emit message schemas early (needed for schema hash)
    const messages = getMessages(res);
    const schemas = messages.map(m => emitMessageSchema(m));
    // Emit per-role IRGraphs (first pass: emit + validate, collect graphs)
    for (const proto of protocols) {
        resetIdCounter();
        const result = emitIR(proto);
        if (!result.ok) {
            console.error(`IR errors in protocol ${proto.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
            hasErrors = true;
        }
        for (const entry of result.sourceMap) {
            allSourceMapEntries.push({ ...entry, file });
        }
        const roleGraphs = new Map();
        for (const [role, graph] of result.graphs) {
            const v = validateIRGraph(graph);
            if (!v.ok) {
                console.error(`Validation errors in ${proto.name}/${role}:`);
                for (const e of v.errors)
                    console.error(`  [${e.code}] ${e.message}`);
                hasErrors = true;
            }
            roleGraphs.set(role, graph);
        }
        protocolGraphs.set(proto.name, roleGraphs);
    }
    // Compute fingerprints + versions for each protocol, attach to graphs
    for (const [protoName, roleGraphs] of protocolGraphs) {
        const usedNames = extractUsedMessageNames(roleGraphs);
        const fp = computeProtocolFingerprint(roleGraphs, schemas, usedNames);
        const deps = extractDependencies(roleGraphs);
        const { version } = computeProtocolVersion(protoName, fp, lock);
        // Resolve dependency versions from lock
        for (const dep of deps) {
            const depEntry = newLock.protocols[dep.protocolName];
            if (depEntry) {
                dep.version = depEntry.version;
                dep.structureHash = depEntry.fingerprints.structureHash;
            }
        }
        // Attach fingerprint data to every role graph of this protocol
        for (const graph of roleGraphs.values()) {
            graph.version = version;
            graph.fingerprints = fp;
            graph.dependencies = deps.length > 0 ? deps : undefined;
        }
        newLock.protocols[protoName] = { version, fingerprints: fp };
    }
    // Write per-role IRGraphs (now with fingerprints)
    for (const [protoName, roleGraphs] of protocolGraphs) {
        for (const [role, graph] of roleGraphs) {
            const fname = `${protoName}.${role}.ir.json`;
            writeFileSync(join(outDir, fname), JSON.stringify(graph, null, 2) + "\n");
            console.log(`  ${fname}`);
            protoRoleCount++;
        }
    }
    // Emit per-role RoleIRs (rich behavioral contracts) with fingerprints
    const protoVersionMap = new Map();
    for (const [name, entry] of Object.entries(newLock.protocols)) {
        protoVersionMap.set(name, entry.version);
    }
    const emittedRoleIRs = [];
    for (const role of roles) {
        const result = emitRoleIR(role, roleMap);
        if (!result.ok) {
            console.error(`Role IR errors in ${role.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
            hasErrors = true;
        }
        for (const p of result.roleIR.plays) {
            p.protocolVersion = protoVersionMap.get(p.protocolName);
        }
        const roleFP = computeRoleFingerprint(result.roleIR, protoVersionMap);
        const { version } = computeRoleVersion(role.name, roleFP, lock);
        result.roleIR.version = version;
        result.roleIR.fingerprints = roleFP;
        newLock.roles[role.name] = { version, fingerprints: roleFP };
        emittedRoleIRs.push(result.roleIR);
        const fname = `${role.name}.role.json`;
        writeFileSync(join(outDir, fname), JSON.stringify(result.roleIR, null, 2) + "\n");
        console.log(`  ${fname}`);
        roleDefCount++;
    }
    // Emit per-agent AgentIRs (thin deployment bindings)
    for (const agent of agents) {
        const result = emitAgentIR(agent, roleMap);
        if (!result.ok) {
            console.error(`Agent IR errors in ${agent.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
            hasErrors = true;
        }
        const fname = `${agent.name}.agent.json`;
        writeFileSync(join(outDir, fname), JSON.stringify(result.agentIR, null, 2) + "\n");
        console.log(`  ${fname}`);
        agentCount++;
    }
    const roleToAgent = {};
    const deploymentAgents = [];
    for (const agent of agents) {
        const agentResult = emitAgentIR(agent, roleMap);
        const roleDef = roleMap.get(agent.runs);
        const roleResult = roleDef ? emitRoleIR(roleDef, roleMap) : undefined;
        const plays = roleResult?.roleIR.plays ?? [];
        const da = {
            agentName: agent.name,
            lang: agentResult.agentIR.lang,
            roleName: agent.runs,
            agentIRFile: `${agent.name}.agent.json`,
            roleIRFile: `${agent.runs}.role.json`,
            roles: [],
        };
        for (const p of plays) {
            const key = `${p.protocolName}.${p.roleName}`;
            da.roles.push({
                protocolName: p.protocolName,
                roleName: p.roleName,
                irGraphFile: `${key}.ir.json`,
            });
            const existing = roleToAgent[key];
            if (existing === undefined) {
                roleToAgent[key] = agent.name;
            }
            else if (Array.isArray(existing)) {
                if (!existing.includes(agent.name))
                    existing.push(agent.name);
            }
            else if (existing !== agent.name) {
                roleToAgent[key] = [existing, agent.name];
            }
        }
        deploymentAgents.push(da);
    }
    // Write message schemas
    if (schemas.length > 0) {
        writeFileSync(join(outDir, "messages.json"), JSON.stringify(schemas, null, 2) + "\n");
        console.log("  messages.json");
    }
    const roleFiles = roles.map(r => ({ name: r.name, file: `${r.name}.role.json` }));
    const deployment = {
        agents: deploymentAgents,
        roleToAgent,
        roles: roleFiles.length > 0 ? roleFiles : undefined,
        messages: schemas.length > 0 ? "messages.json" : undefined,
    };
    writeFileSync(join(outDir, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
    console.log("  deployment.json");
    // Emit source map
    if (allSourceMapEntries.length > 0) {
        const sourceMap = { entries: allSourceMapEntries };
        writeFileSync(join(outDir, "source-map.json"), JSON.stringify(sourceMap, null, 2) + "\n");
        console.log("  source-map.json");
    }
    // Write updated lock file
    writeLock(lockPath, newLock);
    console.log(`  reagent.lock`);
    console.log(`\n${protoRoleCount} protocol role IR(s), ${roleDefCount} role def(s), ${agentCount} agent IR(s), ${schemas.length} message schema(s) → ${outDir}`);
    if (hasErrors) {
        console.error("\nCompilation completed with errors.");
        process.exit(1);
    }
}
// ── init ─────────────────────────────────────────────────────────────
function cmdInit(dir) {
    const projectDir = resolve(dir ?? ".");
    scaffoldProject(projectDir);
}
// ── build ────────────────────────────────────────────────────────────
function cmdBuild(projectDir) {
    const root = resolve(projectDir ?? ".");
    const manifest = loadManifest(root);
    const outDir = resolve(root, manifest.outDir ?? "out");
    mkdirSync(outDir, { recursive: true });
    const rgFiles = resolveGlobs(root, manifest.protocols);
    if (rgFiles.length === 0) {
        console.error(`No .rg files matched by protocols patterns: ${manifest.protocols.join(", ")}`);
        process.exit(1);
    }
    console.log(`Building project "${manifest.name}" (${rgFiles.length} file(s))\n`);
    const lockPath = join(root, "reagent.lock");
    const lock = readLock(lockPath);
    const newLock = {
        protocols: { ...(lock?.protocols ?? {}) },
        roles: { ...(lock?.roles ?? {}) },
    };
    let totalProtoRoles = 0;
    let totalRoleDefs = 0;
    let totalAgents = 0;
    let totalSchemas = 0;
    let hasErrors = false;
    const allProtocolGraphs = new Map();
    const allSchemas = [];
    const allRoles = [];
    const allAgents = [];
    const allRoleMap = new Map();
    const allSourceMapEntries = [];
    for (const file of rgFiles) {
        const relPath = file.startsWith(root) ? file.substring(root.length + 1) : file;
        console.log(`  Compiling ${relPath}`);
        const res = parseFile(file);
        const protocols = getProtocols(res);
        const messages = getMessages(res);
        const roles = getRoles(res);
        const agents = getAgents(res);
        const roleMap = buildRoleMap(res);
        for (const [k, v] of roleMap)
            allRoleMap.set(k, v);
        allRoles.push(...roles);
        allAgents.push(...agents);
        allSchemas.push(...messages.map(m => emitMessageSchema(m)));
        for (const proto of protocols) {
            resetIdCounter();
            const result = emitIR(proto);
            if (!result.ok) {
                console.error(`  IR errors in ${proto.name}:`);
                for (const e of result.errors)
                    console.error(`    ${e}`);
                hasErrors = true;
            }
            for (const entry of result.sourceMap) {
                allSourceMapEntries.push({ ...entry, file });
            }
            const roleGraphs = new Map();
            for (const [role, graph] of result.graphs) {
                const v = validateIRGraph(graph);
                if (!v.ok) {
                    console.error(`  Validation errors in ${proto.name}/${role}:`);
                    for (const e of v.errors)
                        console.error(`    [${e.code}] ${e.message}`);
                    hasErrors = true;
                }
                roleGraphs.set(role, graph);
            }
            allProtocolGraphs.set(proto.name, roleGraphs);
        }
    }
    // Cross-protocol invocability validation
    const invocabilityErrors = validateInvocability(allProtocolGraphs);
    if (invocabilityErrors.length > 0) {
        for (const e of invocabilityErrors)
            console.error(`  ${e}`);
        hasErrors = true;
    }
    for (const [protoName, roleGraphs] of allProtocolGraphs) {
        const usedNames = extractUsedMessageNames(roleGraphs);
        const fp = computeProtocolFingerprint(roleGraphs, allSchemas, usedNames);
        const deps = extractDependencies(roleGraphs);
        const { version } = computeProtocolVersion(protoName, fp, lock);
        for (const dep of deps) {
            const depEntry = newLock.protocols[dep.protocolName];
            if (depEntry) {
                dep.version = depEntry.version;
                dep.structureHash = depEntry.fingerprints.structureHash;
            }
        }
        for (const graph of roleGraphs.values()) {
            graph.version = version;
            graph.fingerprints = fp;
            graph.dependencies = deps.length > 0 ? deps : undefined;
        }
        newLock.protocols[protoName] = { version, fingerprints: fp };
    }
    for (const [protoName, roleGraphs] of allProtocolGraphs) {
        for (const [role, graph] of roleGraphs) {
            const fname = `${protoName}.${role}.ir.json`;
            writeFileSync(join(outDir, fname), JSON.stringify(graph, null, 2) + "\n");
            totalProtoRoles++;
        }
    }
    const protoVersionMap = new Map();
    for (const [name, entry] of Object.entries(newLock.protocols)) {
        protoVersionMap.set(name, entry.version);
    }
    for (const role of allRoles) {
        const result = emitRoleIR(role, allRoleMap);
        if (!result.ok) {
            console.error(`  Role IR errors in ${role.name}:`);
            for (const e of result.errors)
                console.error(`    ${e}`);
            hasErrors = true;
        }
        for (const p of result.roleIR.plays) {
            p.protocolVersion = protoVersionMap.get(p.protocolName);
        }
        const roleFP = computeRoleFingerprint(result.roleIR, protoVersionMap);
        const { version } = computeRoleVersion(role.name, roleFP, lock);
        result.roleIR.version = version;
        result.roleIR.fingerprints = roleFP;
        newLock.roles[role.name] = { version, fingerprints: roleFP };
        writeFileSync(join(outDir, `${role.name}.role.json`), JSON.stringify(result.roleIR, null, 2) + "\n");
        totalRoleDefs++;
    }
    const roleToAgent = {};
    const deploymentAgents = [];
    for (const agent of allAgents) {
        const agentResult = emitAgentIR(agent, allRoleMap);
        if (!agentResult.ok) {
            console.error(`  Agent IR errors in ${agent.name}:`);
            for (const e of agentResult.errors)
                console.error(`    ${e}`);
            hasErrors = true;
        }
        writeFileSync(join(outDir, `${agent.name}.agent.json`), JSON.stringify(agentResult.agentIR, null, 2) + "\n");
        totalAgents++;
        const roleDef = allRoleMap.get(agent.runs);
        const roleResult = roleDef ? emitRoleIR(roleDef, allRoleMap) : undefined;
        const plays = roleResult?.roleIR.plays ?? [];
        const da = {
            agentName: agent.name,
            lang: agentResult.agentIR.lang,
            roleName: agent.runs,
            agentIRFile: `${agent.name}.agent.json`,
            roleIRFile: `${agent.runs}.role.json`,
            roles: [],
        };
        for (const p of plays) {
            const key = `${p.protocolName}.${p.roleName}`;
            da.roles.push({ protocolName: p.protocolName, roleName: p.roleName, irGraphFile: `${key}.ir.json` });
            const existing = roleToAgent[key];
            if (existing === undefined) {
                roleToAgent[key] = agent.name;
            }
            else if (Array.isArray(existing)) {
                if (!existing.includes(agent.name))
                    existing.push(agent.name);
            }
            else if (existing !== agent.name) {
                roleToAgent[key] = [existing, agent.name];
            }
        }
        deploymentAgents.push(da);
    }
    if (allSchemas.length > 0) {
        writeFileSync(join(outDir, "messages.json"), JSON.stringify(allSchemas, null, 2) + "\n");
        totalSchemas = allSchemas.length;
    }
    const roleFiles = allRoles.map(r => ({ name: r.name, file: `${r.name}.role.json` }));
    const deployment = {
        agents: deploymentAgents,
        roleToAgent,
        roles: roleFiles.length > 0 ? roleFiles : undefined,
        messages: allSchemas.length > 0 ? "messages.json" : undefined,
    };
    writeFileSync(join(outDir, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
    if (allSourceMapEntries.length > 0) {
        writeFileSync(join(outDir, "source-map.json"), JSON.stringify({ entries: allSourceMapEntries }, null, 2) + "\n");
    }
    writeLock(lockPath, newLock);
    console.log(`\n${totalProtoRoles} protocol role IR(s), ${totalRoleDefs} role def(s), ${totalAgents} agent IR(s), ${totalSchemas} message schema(s) → ${outDir}`);
    console.log(`  reagent.lock updated`);
    if (hasErrors) {
        console.error("\nBuild completed with errors.");
        process.exit(1);
    }
}
// ── verify ──────────────────────────────────────────────────────────
async function cmdVerify(file) {
    const { generateTLAPlus, generateTLCConfig } = await import("./tla-generator.js");
    const { execSync } = await import("node:child_process");
    const { unlinkSync } = await import("node:fs");
    const res = parseFile(file);
    const protocols = getProtocols(res);
    if (protocols.length === 0) {
        console.error("No protocols found in", file);
        process.exit(1);
    }
    for (const proto of protocols) {
        resetIdCounter();
        const result = emitIR(proto);
        if (!result.ok) {
            console.error(`IR errors in protocol ${proto.name}:`);
            for (const e of result.errors)
                console.error(`  ${e}`);
        }
        const tla = generateTLAPlus(proto.name, result.graphs);
        const roles = [...result.graphs.keys()];
        const cfg = generateTLCConfig(proto.name, roles);
        const sanitized = proto.name.replace(/[^a-zA-Z0-9_]/g, "_");
        const tlaFile = `${sanitized}.tla`;
        const cfgFile = `${sanitized}.cfg`;
        writeFileSync(tlaFile, tla);
        writeFileSync(cfgFile, cfg);
        console.log(`\n=== ${proto.name} ===`);
        console.log(`  Generated: ${tlaFile}, ${cfgFile}`);
        console.log(`  Roles: ${roles.join(", ")}`);
        console.log(`  States per role: ${roles.map((r) => `${r}=${result.graphs.get(r).states.length}`).join(", ")}`);
        // Try to run TLC if available
        let tlcAvailable = false;
        try {
            execSync("which tlc", { stdio: "ignore" });
            tlcAvailable = true;
        }
        catch { /* tlc not found */ }
        if (tlcAvailable) {
            console.log(`  Running TLC model checker...`);
            try {
                const output = execSync(`tlc ${tlaFile} -config ${cfgFile} -workers auto 2>&1`, {
                    encoding: "utf8",
                    timeout: 60000,
                });
                if (output.includes("No error")) {
                    console.log(`  ✓ ${proto.name}: all properties satisfied`);
                }
                else {
                    console.log(`  TLC output:\n${output}`);
                }
            }
            catch (tlcErr) {
                const output = tlcErr.stdout ?? tlcErr.message;
                if (output.includes("Error:") || output.includes("Invariant") || output.includes("violated")) {
                    console.error(`  ✗ ${proto.name}: property violation detected`);
                    console.error(output);
                    process.exit(1);
                }
                console.log(`  TLC output:\n${output}`);
            }
        }
        else {
            console.log(`  (TLC not found on PATH — run manually: tlc ${tlaFile} -config ${cfgFile})`);
        }
        try {
            unlinkSync(tlaFile);
        }
        catch { /* ignore */ }
        try {
            unlinkSync(cfgFile);
        }
        catch { /* ignore */ }
    }
}
// ── deploy ───────────────────────────────────────────────────────────
async function cmdDeploy(projectDir, rosUrl) {
    const root = resolve(projectDir ?? ".");
    const manifest = loadManifest(root);
    const outDir = resolve(root, manifest.outDir ?? "out");
    // Build first if needed
    const deploymentPath = join(outDir, "deployment.json");
    try {
        readFileSync(deploymentPath, "utf8");
    }
    catch {
        console.log("No compiled output found, building first...\n");
        cmdBuild(projectDir);
    }
    const url = rosUrl ?? "ws://127.0.0.1:18789";
    console.log(`\nDeploying "${manifest.name}" to ROS at ${url}...`);
    // Build DeploySpec from compiled output
    const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
    const lockPath = join(root, "reagent.lock");
    let lock = {};
    try {
        lock = JSON.parse(readFileSync(lockPath, "utf8"));
    }
    catch { /* no lock yet */ }
    const protocols = [];
    const seenProtos = new Set();
    for (const agent of deployment.agents) {
        for (const role of agent.roles) {
            if (seenProtos.has(role.protocolName))
                continue;
            seenProtos.add(role.protocolName);
            const lockEntry = lock.protocols?.[role.protocolName];
            protocols.push({
                name: role.protocolName,
                version: lockEntry?.version ?? "0.0.0",
                fingerprints: lockEntry?.fingerprints ?? { structureHash: "", schemaHash: "", implHash: "" },
                artifactsPath: outDir,
            });
        }
    }
    const agents = deployment.agents.map((a) => ({
        agentName: a.agentName,
        roleName: a.roleName,
        protocolName: a.roles[0]?.protocolName ?? "",
    }));
    const deploySpec = {
        deploymentId: `${manifest.name}@${manifest.version}`,
        protocols,
        agents,
    };
    // Try to connect to ROS and submit
    try {
        const { WebSocket } = await import("ws");
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            ws.on("open", resolve);
            ws.on("error", reject);
            setTimeout(() => reject(new Error("Connection timeout")), 5000);
        });
        const requestId = `deploy-${Date.now()}`;
        ws.send(JSON.stringify({
            rap: "SubmitDeploySpec",
            id: requestId,
            payload: { requestId, deploySpec },
        }));
        const response = await new Promise((resolve, reject) => {
            ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.rap === "SubmitDeploySpecAccepted" || msg.rap === "SubmitDeploySpecRejected") {
                    resolve(msg);
                }
            });
            setTimeout(() => reject(new Error("Response timeout")), 10000);
        });
        ws.close();
        if (response.rap === "SubmitDeploySpecAccepted") {
            console.log(`\nDeployment accepted: ${response.payload.deploymentId}`);
            console.log(`  Actions: ${response.payload.actionCount}`);
            console.log(`  Conflicts: ${response.payload.conflictCount}`);
            console.log(`\n${response.payload.planSummary}`);
        }
        else {
            console.error(`\nDeployment rejected: ${response.payload.error}`);
            if (response.payload.conflicts?.length > 0) {
                for (const c of response.payload.conflicts) {
                    console.error(`  - ${c.message}`);
                }
            }
            process.exit(1);
        }
    }
    catch (err) {
        if (err.code === "ECONNREFUSED" || err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Connection timeout") || err.message?.includes("Cannot find package")) {
            console.log("\nROS not available (or ws module not installed). Generating deployment plan locally...\n");
            console.log("DeploySpec:");
            console.log(JSON.stringify(deploySpec, null, 2));
            console.log("\nTo deploy with live ROS, install ws (`npm i ws`) and start ROS, then run: reagent-lang deploy");
        }
        else {
            console.error(`Deploy failed: ${err.message}`);
            process.exit(1);
        }
    }
}
// ── main ────────────────────────────────────────────────────────────
function main() {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd)
        usage();
    switch (cmd) {
        case "parse": {
            if (!args[0])
                usage();
            cmdParse(args[0]);
            break;
        }
        case "ir": {
            if (!args[0])
                usage();
            cmdIR(args[0], args[1]);
            break;
        }
        case "validate": {
            if (!args[0])
                usage();
            cmdValidate(args[0], args[1]);
            break;
        }
        case "compile": {
            if (!args[0] || !args[1]) {
                console.error("compile requires: reagent-lang compile <file.rg> <out-dir>");
                process.exit(2);
            }
            cmdCompile(args[0], args[1]);
            break;
        }
        case "init":
            cmdInit(args[0]);
            break;
        case "build":
            cmdBuild(args[0]);
            break;
        case "verify": {
            if (!args[0]) {
                console.error("verify requires: reagent-lang verify <file.rg>");
                process.exit(2);
            }
            cmdVerify(args[0]).catch((err) => {
                console.error(`Verify error: ${err.message}`);
                process.exit(1);
            });
            break;
        }
        case "decompile": {
            if (!args[0]) {
                console.error("decompile requires: reagent-lang decompile <dir|file.ir.json>");
                process.exit(2);
            }
            import("./ir-decompiler.js").then(({ cmdDecompile }) => {
                cmdDecompile(args[0]);
            });
            break;
        }
        case "deploy":
            cmdDeploy(args[0], args[1]).catch(err => {
                console.error(`Deploy error: ${err.message}`);
                process.exit(1);
            });
            break;
        default:
            console.error(`Unknown command: ${cmd}`);
            usage();
    }
}
main();
