"""
auction-sim runner — Python-native execution via ReagentController.

Usage:
    python run.py                       # default: item="Rare Painting", reserve=100
    python run.py --item "Gold Watch"   # custom item
    python run.py --reserve 200         # custom reserve price

Requires: reagent_runtime on PYTHONPATH (or pip install -e ../../runtime/py)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import uuid

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_DIR = os.path.join(SCRIPT_DIR, "..", "..", "..", "runtime", "py")
sys.path.insert(0, os.path.normpath(RUNTIME_DIR))

from reagent_runtime import ReagentController, InprocAgentNode

log = logging.getLogger("auction-sim")

IR_DIR = os.path.join(SCRIPT_DIR, "out")
BUYER_NAMES = ["Buyer1", "Buyer2", "Buyer3"]


async def run_auction(item_name: str, reserve_price: float, dump: bool = False) -> None:
    node = InprocAgentNode(role_to_agent={})
    rc = ReagentController(node_id="auction-sim", agent_node=node)

    role_to_agent = rc.load(IR_DIR)
    role_to_agent["Auction.seller"] = "Auctioneer"
    for name in BUYER_NAMES:
        role_to_agent["Auction.buyer"] = name

    await rc.start()

    instance_id = f"auction-{uuid.uuid4().hex[:8]}"
    trigger = {
        "instanceId": instance_id,
        "protocolName": "Auction",
        "input": {
            "itemName": item_name,
            "reservePrice": reserve_price,
        },
        "roleToAgent": role_to_agent,
    }
    rc.trigger_protocol("Auctioneer", trigger)

    seller_handle = rc.get_agent("Auctioneer")
    await seller_handle.wait_for_completion(expected_count=1, timeout_s=10)

    for name in BUYER_NAMES:
        handle = rc.get_agent(name)
        try:
            await handle.wait_for_completion(expected_count=1, timeout_s=5)
        except (TimeoutError, RuntimeError):
            log.warning("Buyer %s did not complete in time", name)

    await rc.stop()

    print("\n" + "=" * 60)
    print("AUCTION RESULTS")
    print("=" * 60)

    seller_self = seller_handle.get_self()
    auction_log = seller_self.get("auctionLog", {})
    winner_idx = auction_log.get("winner")
    winner_name = (
        BUYER_NAMES[winner_idx]
        if isinstance(winner_idx, int) and 0 <= winner_idx < len(BUYER_NAMES)
        else "none"
    )
    print(f"\n  Item:       {auction_log.get('item', '?')}")
    print(f"  Winner:     {winner_name}")
    print(f"  Price:      {auction_log.get('price', '?')}")
    print(f"  Total bids: {auction_log.get('totalBids', '?')}")

    print(f"\n  {'Agent':<12} {'Result':<8} {'State'}")
    print(f"  {'-'*12} {'-'*8} {'-'*30}")
    for name in BUYER_NAMES:
        handle = rc.get_agent(name)
        s = handle.get_self()
        result = s.get("lastResult", "?")
        print(f"  {name:<12} {result:<8} {json.dumps(dict(s), default=str)}")

    if dump:
        print("\n" + rc.dump_pretty())

    print("\n" + "=" * 60)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run auction-sim")
    parser.add_argument("--item", default="Rare Painting", help="Item name")
    parser.add_argument("--reserve", type=float, default=100.0, help="Reserve price")
    parser.add_argument("--dump", action="store_true", help="Print RC internal tables after run")
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)-20s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )

    asyncio.run(run_auction(args.item, args.reserve, dump=args.dump))


if __name__ == "__main__":
    main()
