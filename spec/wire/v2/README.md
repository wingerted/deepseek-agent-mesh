# Mesh wire v2

The current wire generation uses libp2p request-response CBOR for advertisement,
inventory, chunks, receipts, and durable envelopes. Rust definitions in
`crates/agent-mesh/src/protocol.rs` and `envelope.rs` are authoritative until
machine-readable schemas are introduced.

Membership admission uses the same authenticated request-response transport:

- A founder creates a `mesh1:` ticket containing the network ID, founder Peer
  ID/public key, reachable bootstrap multiaddrs, a random one-use token, expiry,
  and an Ed25519 signature over all preceding fields.
- The founder stores only the token SHA-256 digest. `JoinNetwork` presents the
  token over the Noise-authenticated libp2p connection and consumes it exactly
  once.
- `NetworkJoined` returns a founder-signed membership certificate binding the
  network ID and joining transport Peer ID. Durable envelopes carry that
  certificate; receivers validate the signature, binding and expiry.
- Every node runs a libp2p Rendezvous server and clients use namespace
  `agent-mesh/<network_id>`. Nodes register and discover through connected peers;
  signed peer records returned by rendezvous nodes are dialing hints, not authorization. Membership certificates remain
  the admission authority.

Protocol v1 deliberately uses one founder root. It does not yet define member
revocation, certificate renewal, delegated issuers, root rotation, or quorum
governance. Tickets are bearer secrets until redeemed and must not be logged.

Breaking wire changes require a new protocol name/version rather than changing
the meaning of an existing message in place.
