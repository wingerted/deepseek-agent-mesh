# Local RPC v1

The daemon writes `control.json` containing `version`, loopback `address`,
random `token`, and `peer_id`. Clients send one newline-delimited JSON request
per TCP connection:

```json
{"token":"...","method":"status","params":{}}
```

The daemon replies with exactly one newline-delimited object. A successful
reply has `{"ok":true,"result":...}`; a failure has
`{"ok":false,"error":"..."}`. The Node implementation lives in
`packages/mesh-rpc`, and the Rust implementation lives in
`crates/agent-mesh/src/ipc.rs`.
