// SWIM-like gossip protocol for node discovery and failure detection.
//
// Each node periodically pings a random peer. If the peer doesn't respond
// within the timeout, the node issues an indirect ping through k other
// peers before declaring the target suspect/dead.
//
// Membership list changes (join, suspect, dead) are piggybacked on all
// gossip messages for protocol-free dissemination.

protocol Ping(Prober -> Target) {
  Prober sends Ping {
    sender_id: string,
    incarnation: number,
    membership_digest: string[]
  }
  Target receives Ping

  alt {
    [alive] {
      Target sends Ack {
        sender_id: string,
        incarnation: number,
        membership_updates: string[]
      }
      Prober receives Ack
    }
    [timeout] {
      // No Ack received within deadline — escalate to indirect ping.
    }
  }
}

protocol IndirectPing(Requester -> Relay -> Suspect) {
  Requester sends PingReq {
    target_id: string,
    requester_id: string,
    incarnation: number
  }
  Relay receives PingReq

  Relay sends IndirectPing {
    target_id: string,
    requester_id: string,
    relay_id: string,
    incarnation: number
  }
  Suspect receives IndirectPing

  alt {
    [alive] {
      Suspect sends IndirectAck {
        target_id: string,
        incarnation: number
      }
      Relay receives IndirectAck

      Relay sends PingReqAck {
        target_id: string,
        alive: true,
        incarnation: number
      }
      Requester receives PingReqAck
    }
    [timeout] {
      Relay sends PingReqAck {
        target_id: string,
        alive: false,
        incarnation: number
      }
      Requester receives PingReqAck
    }
  }
}

protocol MembershipUpdate(Source -> Peer) {
  Source sends MembershipChange {
    node_id: string,
    status: string,         // "alive" | "suspect" | "dead" | "join"
    incarnation: number,
    agent_list: string[],
    timestamp: number
  }
  Peer receives MembershipChange

  Peer sends MembershipAck {
    node_id: string,
    accepted: boolean
  }
  Source receives MembershipAck
}

// Roles

role DiscoveryRole [ts] {
  plays Prober in Ping
  plays Target in Ping
  plays Requester in IndirectPing
  plays Relay in IndirectPing
  plays Suspect in IndirectPing
  plays Source in MembershipUpdate
  plays Peer in MembershipUpdate
}

agent DiscoveryAgent runs DiscoveryRole
