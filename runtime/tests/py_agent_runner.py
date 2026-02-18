"""
Helper script to run a Python agent for cross-language E2E tests.

Usage:
  python py_agent_runner.py <fixtures-dir> <agent-name> <nats-url> <instance-id> <role-to-agent-json>

The script:
1. Loads agent IR and graphs from fixtures-dir
2. Starts the agent (connects to NATS, subscribes)
3. Triggers the protocol instance
4. Waits for completion (up to 15s)
5. Prints JSON results to stdout
"""

import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from reagent_runtime.agent_runner import AgentRunner


async def main():
    if len(sys.argv) < 6:
        print("Usage: py_agent_runner.py <fixtures-dir> <agent-name> <nats-url> <instance-id> <role-to-agent-json>", file=sys.stderr)
        sys.exit(2)

    fixtures_dir = sys.argv[1]
    agent_name = sys.argv[2]
    nats_url = sys.argv[3]
    instance_id = sys.argv[4]
    role_to_agent = json.loads(sys.argv[5])

    deployment_file = os.path.join(fixtures_dir, "deployment.json")
    with open(deployment_file) as f:
        deployment = json.load(f)

    agent_ir_file = os.path.join(fixtures_dir, f"{agent_name}.agent.json")
    with open(agent_ir_file) as f:
        thin_agent_ir = json.load(f)

    role_ir_file = os.path.join(fixtures_dir, thin_agent_ir["roleFile"])
    with open(role_ir_file) as f:
        role_ir = json.load(f)

    agent_ir = {
        "agentName": thin_agent_ir["agentName"],
        "lang": thin_agent_ir["lang"],
        "roleName": thin_agent_ir["roleName"],
        "plays": role_ir["plays"],
        "initAction": role_ir.get("initAction"),
        "lifecycleHandlers": role_ir.get("lifecycleHandlers", []),
    }

    graphs = {}
    for play in role_ir["plays"]:
        graph_file = os.path.join(fixtures_dir, f"{play['protocolName']}.{play['roleName']}.ir.json")
        with open(graph_file) as f:
            graph = json.load(f)
        key = f"{play['protocolName']}.{play['roleName']}"
        graphs[key] = graph

    protocol_name = role_ir["plays"][0]["protocolName"]

    config = {
        "agentIR": agent_ir,
        "graphs": graphs,
        "natsUrl": nats_url,
        "roleToAgent": role_to_agent,
    }

    runner = AgentRunner(config)
    await runner.start()

    await asyncio.sleep(0.3)

    await runner.start_protocol_instance(instance_id, protocol_name, {}, role_to_agent)

    await runner.wait_for_completion(1, 15.0)

    instance = runner.instances.get(instance_id)
    traces = []
    if instance:
        for t in instance.traces:
            try:
                json.dumps(t)
                traces.append(t)
            except (TypeError, ValueError):
                traces.append({"kind": str(t.get("kind", "?")), "note": "non-serializable"})

    result = {
        "status": instance.status if instance else "not_found",
        "self": runner.self_state,
        "traces": traces,
    }
    print("RESULT:" + json.dumps(result))

    await runner.stop()


if __name__ == "__main__":
    asyncio.run(main())
