// Example 24: Call for Proposal (CFP) pattern via scatter
//
// Buyer sends a CFP to each seller in a dynamic list.
// Each seller may Propose, Refuse, or time out.
// Buyer collects proposals, then selects the best one.
//
// This is the classic FIPA Contract Net Interaction Protocol.

message CFP {}
message Propose {}
message Refuse {}
message Accept {}
message Reject {}

protocol CallForProposal {
  participants:
    buyer [ts] initiator,
    seller [ts] many
  trigger on invoke with CFPRequest {
    resolve buyer = single
    resolve seller = single
  }

  buyer {
    $ctx.candidates = $ctx.input.sellerIds
    $ctx.spec = $ctx.input.spec
    $ctx.proposals = []
  }

  scatter ($ctx.candidates as seller) {
    buyer --> seller: CFP = {
      onSend {
        $ctx.msg.spec = $ctx.spec
      }
      onReceive {
        $ctx.spec = $ctx.msg.spec
      }
    }

    seller {
      $ctx.canFulfill = evaluate($ctx.spec)
    }

    alt at seller ($ctx.canFulfill == true) {
      seller --> buyer: Propose = {
        onSend {
          $ctx.msg.price = $ctx.price
          $ctx.msg.sellerId = $ctx.msg.sellerId
        }
        onReceive {
          $ctx.proposals.push($ctx.msg)
        }
      }
    } else {
      seller --> buyer: Refuse = { }
    }
  }

  buyer {
    $ctx.winner = selectBest($ctx.proposals)
  }

  // Notify all sellers of the outcome.
  scatter ($ctx.candidates as seller) {
    alt at buyer ($ctx._scatterItem == $ctx.winner.sellerId) {
      buyer --> seller: Accept = {
        onSend {
          $ctx.msg.winnerId = $ctx.winner.sellerId
        }
      }
    } else {
      buyer --> seller: Reject = { }
    }
  }
}

role BuyerRole [ts] {
  plays CallForProposal as buyer

  init {
    $self.cfpsCompleted = 0
  }

  on protocolCompleted(CallForProposal) {
    $self.cfpsCompleted += 1
  }
}

role SellerRole [ts] {
  plays CallForProposal as seller
}

agent BuyerAgent runs BuyerRole
agent SellerAgent runs SellerRole
