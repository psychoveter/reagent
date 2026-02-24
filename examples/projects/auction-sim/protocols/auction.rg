// Auction — single-round sealed-bid auction
//
// Seller announces an item with a reserve price.
// N buyers submit bids simultaneously (scatter).
// Seller evaluates bids, picks the winner (or rejects all if below reserve).
// Winner gets a confirmation, losers get a rejection.

message AuctionStart {
  itemName: string
  reservePrice: number
}

message Bid {
  amount: number
}

message BidResult {
  won: boolean
  finalPrice: number
}

message AuctionSummary {
  winnerId: string
  finalPrice: number
  totalBids: number
}

protocol Auction {
  participants: seller [py], buyer [py]
  initiator: seller
  input: AuctionStart

  seller {
    $flow.itemName = $ctx.input.itemName
    $flow.reservePrice = $ctx.input.reservePrice
    $flow.buyerIds = await $agent.get_buyer_ids()
    $flow.bids = []
  }

  // Scatter: announce item to all buyers, collect bids
  scatter ($flow.buyerIds as buyer) {
    seller --> buyer: AuctionStart = {
      onSend {
        $ctx.msg.itemName = $flow.itemName
        $ctx.msg.reservePrice = $flow.reservePrice
      }
      onReceive {
        $self.currentItem = $ctx.msg.itemName
      }
    }

    buyer {
      $ctx.bidAmount = await $agent.decide_bid($self.currentItem, $ctx.msg.reservePrice)
    }

    buyer --> seller: Bid = {
      onSend {
        $ctx.msg.amount = $ctx.bidAmount
      }
      onReceive {
        $flow.bids.push({
          buyerIdx: $flow._scatterIdx,
          amount: $ctx.msg.amount
        })
      }
    }
  }

  // Seller evaluates all bids
  seller {
    $ctx.result = await $agent.evaluate_bids($flow.bids, $flow.reservePrice)
    $flow.winnerIdx = $ctx.result.winnerIdx
    $flow.finalPrice = $ctx.result.finalPrice
  }

  // Notify each buyer of the result
  scatter ($flow.buyerIds as buyer) {
    seller --> buyer: BidResult = {
      onSend {
        $ctx.msg.won = ($flow._scatterIdx == $flow.winnerIdx)
        $ctx.msg.finalPrice = $flow.finalPrice
      }
      onReceive {
        $self.lastResult = $ctx.msg.won ? "won" : "lost"
      }
    }
  }

  seller {
    $self.auctionLog = {
      item: $flow.itemName,
      winner: $flow.winnerIdx,
      price: $flow.finalPrice,
      totalBids: $flow.bids.length
    }
  }
}

role SellerRole [py] {
  plays Auction as seller
}

role BuyerRole [py] {
  plays Auction as buyer
}

agent Auctioneer runs SellerRole
agent Buyer1 runs BuyerRole
agent Buyer2 runs BuyerRole
agent Buyer3 runs BuyerRole
