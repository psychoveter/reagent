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
  participants:
    seller [ts] initiator,
    buyer [ts] dynamic many
  
  trigger on invoke with AuctionStart {
    resolve seller = single
  }

  seller {
    $self.auctionLog = $self.auctionLog ?? []
    $ctx.itemName = $ctx.input.itemName
    $ctx.reservePrice = $ctx.input.reservePrice
    $ctx.buyerIds = ["Buyer1", "Buyer2", "Buyer3"]
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
      const reserve = Number($self.reservePrice ?? 0)
      const spread = Math.max(10, reserve * 0.35)
      const rawBid = reserve + (Math.random() * spread)
      $ctx.bidAmount = Math.round(rawBid * 100) / 100
    }

    buyer --> seller: Bid = {
      onSend {
        $ctx.msg.amount = $ctx.bidAmount
      }
      onReceive {
        $ctx.bids.push({
          buyerIdx: $ctx._scatterIdx,
          amount: Number($ctx.msg.amount ?? 0)
        })
      }
    }
  }

  // Seller evaluates all bids
  seller {
    let winnerIdx = -1
    let finalPrice = 0

    for (const bid of $ctx.bids) {
      const amount = Number(bid.amount ?? 0)
      if (amount >= $ctx.reservePrice && amount > finalPrice) {
        winnerIdx = Number(bid.buyerIdx ?? -1)
        finalPrice = amount
      }
    }

    $ctx.result = { winnerIdx, finalPrice }
    $ctx.winnerIdx = winnerIdx
    $ctx.finalPrice = finalPrice
  }

  // Notify each buyer of the result
  scatter ($ctx.buyerIds as buyer) {
    seller --> buyer: BidResult = {
      onSend {
        $ctx.msg.won = ($ctx._scatterIdx == $ctx.winnerIdx)
        $ctx.msg.finalPrice = $ctx.finalPrice
      }
      onReceive {
        $self.lastResult = $ctx.msg.won ? "won" : "lost"
        $self.finalPrice = $ctx.msg.finalPrice
      }
    }
  }

  seller {
    $self.auctionLog.push({
      item: $ctx.itemName,
      winner: $ctx.winnerIdx,
      price: $ctx.finalPrice,
      totalBids: $ctx.bids.length
    })
    $self.lastAuction = $self.auctionLog[$self.auctionLog.length - 1]
    console.log("[auction-sim] completed auction", JSON.stringify($self.lastAuction))
  }
}

role SellerRole [ts] {
  plays Auction as seller
}

role BuyerRole [ts] {
  plays Auction as buyer
}

agent Auctioneer runs SellerRole
agent Buyer1 runs BuyerRole
agent Buyer2 runs BuyerRole
agent Buyer3 runs BuyerRole
