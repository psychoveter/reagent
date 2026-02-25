"""
Auctioneer $agent module — manages auction mechanics.

Exposed to zones as $agent:
  - get_buyer_ids() -> list[str]
  - evaluate_bids(bids, reserve_price) -> dict with winnerIdx, finalPrice
"""

BUYER_IDS = ["Buyer1", "Buyer2", "Buyer3"]


async def get_buyer_ids():
    return BUYER_IDS


async def evaluate_bids(bids, reserve_price):
    """Evaluate a list of bid amounts. Returns winner index and final price."""
    if not bids:
        return {"winnerIdx": -1, "finalPrice": 0}

    best_idx = -1
    best_amount = 0
    for i, amount in enumerate(bids):
        val = amount if isinstance(amount, (int, float)) else 0
        if val >= reserve_price and val > best_amount:
            best_idx = i
            best_amount = val

    return {"winnerIdx": best_idx, "finalPrice": best_amount}
