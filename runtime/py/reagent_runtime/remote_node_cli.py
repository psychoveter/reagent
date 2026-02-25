"""
CLI entry point for running a Python RemoteNode.

Usage::

    python -m reagent_runtime.remote_node_cli \\
        --ros-url ws://127.0.0.1:18789 \\
        --node-id node-py-1 \\
        --agents-dir ./agents
"""

import argparse
import asyncio
import logging
import signal
import sys


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Start a Python Reagent remote node connected to ROS",
    )
    parser.add_argument(
        "--ros-url",
        default="ws://127.0.0.1:18789",
        help="WebSocket URL of the Reagent Orchestrator Service (default: ws://127.0.0.1:18789)",
    )
    parser.add_argument(
        "--node-id",
        default="py-node-1",
        help="Unique identifier for this node (default: py-node-1)",
    )
    parser.add_argument(
        "--agents-dir",
        default=None,
        help="Path to local agents directory for resolving agent.json manifests and native modules",
    )
    parser.add_argument(
        "--no-repl",
        action="store_true",
        help="Disable interactive REPL (just wait for Ctrl+C)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    )

    from .remote_node import RemoteNode

    node = RemoteNode(
        node_id=args.node_id,
        ros_url=args.ros_url,
        agents_dir=args.agents_dir,
    )

    try:
        await node.connect()
    except Exception as exc:
        print(f"Failed to connect to ROS at {args.ros_url}: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"[RemoteNode] {args.node_id} connected to {args.ros_url}")
    if args.agents_dir:
        print(f"[RemoteNode] Agents dir: {args.agents_dir}")

    if args.no_repl:
        print("[RemoteNode] Waiting for Deploy commands... (Ctrl+C to stop)")
        stop_event = asyncio.Event()
        loop = asyncio.get_event_loop()

        def _signal_handler() -> None:
            stop_event.set()

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, _signal_handler)

        await stop_event.wait()
    else:
        await node.repl()

    print("\n[RemoteNode] Shutting down...")
    await node.close()


if __name__ == "__main__":
    asyncio.run(main())
