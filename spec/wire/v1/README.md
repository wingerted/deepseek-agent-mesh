# Mesh wire v1

The first wire generation uses libp2p request-response CBOR for advertisement,
inventory, chunks, receipts, and durable envelopes. Rust definitions in
`crates/agent-mesh/src/protocol.rs` and `envelope.rs` are authoritative until
machine-readable schemas are introduced.

Breaking wire changes require a new protocol name/version rather than changing
the meaning of an existing message in place.
