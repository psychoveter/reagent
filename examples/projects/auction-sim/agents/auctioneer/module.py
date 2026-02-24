"""
Auctioneer $agent module — manages auction mechanics.

Exposed to zones as $agent:
  - get_buyer_ids() -> list[str]
  - evaluate_bids(bids, reserve_price) -> dict with winnerIdx, finalPrice
"""

BUYER_IDS = ["buyer-0", "buyer-1", "buyer-2"]


async def get_buyer_ids():
    return BUYER_IDS


async def evaluate_bids(bids, reserve_price):
    if not bids:
        return {"winnerIdx": -1, "finalPrice": 0}

    valid = [b for b in bids if b["amount"] >= reserve_price]
    if not valid:
        return {"winnerIdx": -1, "finalPrice": 0}

    winner = max(valid, key=lambda b: b["amount"])
    return {
        "winnerIdx": winner["buyerIdx"],
        "finalPrice": winner["amount"],
    }
