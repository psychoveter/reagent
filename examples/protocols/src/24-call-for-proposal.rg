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
  participants: buyer [ts], seller [ts]
  initiator: buyer
  input: CFPRequest

  buyer {
    $flow.candidates = $ctx.input.sellerIds
    $flow.spec = $ctx.input.spec
    $flow.proposals = []
  }

  scatter ($flow.candidates as seller) {
    buyer --> seller: CFP = {
      onSend {
        $ctx.msg.spec = $flow.spec
      }
      onReceive {
        $ctx.spec = $ctx.msg.spec
      }
    }

    seller {
      $ctx.canFulfill = evaluate($ctx.spec)
    }

    alt ($ctx.canFulfill == true) {
      seller --> buyer: Propose = {
        onSend {
          $ctx.msg.price = $ctx.price
          $ctx.msg.sellerId = $ctx.msg.sellerId
        }
        onReceive {
          $flow.proposals.push($ctx.msg)
        }
      }
    } else {
      seller --> buyer: Refuse = { }
    }
  }

  buyer {
    $flow.winner = selectBest($flow.proposals)
  }

  // Notify winner (simplified: in real CFP, you'd scatter accept/reject to all)
  buyer --> seller: Accept = {
    onSend {
      $ctx.msg.winnerId = $flow.winner.sellerId
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
