"""
CLI entry point for running a Reagent agent process (Python).

Usage:
  python -m reagent_runtime --agent <agent-ir.json> --graphs <g1.json> [...] --nats <url> --role-map <deployment.json>
"""

import asyncio
import json
import signal
import sys
from typing import Any

from .agent_runner import AgentRunner


def parse_args() -> dict[str, Any]:
    args = sys.argv[1:]
    agent_file = ""
    graph_files: list[str] = []
    nats_url = "nats://localhost:4222"
    deployment_file = ""

    i = 0
    while i < len(args):
        if args[i] == "--agent":
            i += 1
            agent_file = args[i]
        elif args[i] == "--graphs":
            i += 1
            while i < len(args) and not args[i].startswith("--"):
                graph_files.append(args[i])
                i += 1
            continue
        elif args[i] == "--nats":
            i += 1
            nats_url = args[i]
        elif args[i] == "--role-map":
            i += 1
            deployment_file = args[i]
        i += 1

    if not agent_file or not graph_files or not deployment_file:
        print(
            "Usage: python -m reagent_runtime --agent <agent.json> "
            "--graphs <g1.json> [...] --nats <url> --role-map <deployment.json>",
            file=sys.stderr,
        )
        sys.exit(2)

    return {
        "agentFile": agent_file,
        "graphFiles": graph_files,
        "natsUrl": nats_url,
        "deploymentFile": deployment_file,
    }


async def main() -> None:
    parsed = parse_args()

    with open(parsed["agentFile"]) as f:
        agent_ir = json.load(f)

    with open(parsed["deploymentFile"]) as f:
        deployment = json.load(f)

    graphs: dict[str, dict[str, Any]] = {}
    for gf in parsed["graphFiles"]:
        with open(gf) as f:
            graph = json.load(f)
        key = f"{graph['protocolName']}.{graph['role']}"
        graphs[key] = graph

    config = {
        "agentIR": agent_ir,
        "graphs": graphs,
        "natsUrl": parsed["natsUrl"],
        "roleToAgent": deployment["roleToAgent"],
    }

    runner = AgentRunner(config)
    await runner.start()

    loop = asyncio.get_event_loop()
    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _signal_handler)

    await stop_event.wait()
    await runner.stop()


if __name__ == "__main__":
    asyncio.run(main())
