"""
Buyer $agent module — bidding strategy.

Exposed to zones as $agent:
  - decide_bid(item_name, reserve_price) -> float
"""

import random


async def decide_bid(item_name, reserve_price):
    spread = reserve_price * 0.5
    bid = reserve_price + random.uniform(-spread * 0.3, spread)
    return round(max(0, bid), 2)
