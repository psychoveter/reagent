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
    $ctx.itemName = $ctx.input.itemName
    $ctx.reservePrice = $ctx.input.reservePrice
    $ctx.buyerIds = await $agent.get_buyer_ids()
    $ctx.bids = []
  }

  // Scatter: announce item to all buyers, collect bids
  scatter ($ctx.buyerIds as buyer) {
    seller --> buyer: AuctionStart = {
      onSend {
        $ctx.msg.itemName = $ctx.itemName
        $ctx.msg.reservePrice = $ctx.reservePrice
      }
      onReceive {
        $self.currentItem = $ctx.msg.itemName
        $self.reservePrice = $ctx.msg.reservePrice
      }
    }

    buyer {
      $ctx.bidAmount = await $agent.decide_bid($self.currentItem, $self.reservePrice)
    }

    buyer --> seller: Bid = {
      onSend {
        $ctx.msg.amount = $ctx.bidAmount
      }
      onReceive {
        $ctx.bids.push($ctx.msg.amount)
      }
    }
  }

  // Seller evaluates all bids
  seller {
    $ctx.result = await $agent.evaluate_bids($ctx.bids, $ctx.reservePrice)
    $ctx.winnerIdx = $ctx.result.winnerIdx
    $ctx.finalPrice = $ctx.result.finalPrice
  }

  // Notify each buyer of the result
  scatter ($ctx.buyerIds as buyer) {
    seller --> buyer: BidResult = {
      onSend {
        $ctx.msg.won = ($ctx._scatterIdx == $ctx.winnerIdx)
        $ctx.msg.finalPrice = $ctx.finalPrice
      }
      onReceive {
        $self.lastResult = "won" if $ctx.msg.won else "lost"
      }
    }
  }

  seller {
    $self.auctionLog = {
      "item": $ctx.itemName,
      "winner": $ctx.winnerIdx,
      "price": $ctx.finalPrice,
      "totalBids": len($ctx.bids)
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
