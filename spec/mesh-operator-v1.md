# `mesh-watcher/1`

`mesh-watcher/1` is the application payload contract used by non-executing Watcher members, including the iOS app. Transport, authentication, expiry, and persistence are provided by the existing Agent Mesh envelope protocol.

A Watcher advertises `node_role: "watcher"` and `leader: null`. `node_role` is self-declared routing and presentation metadata, never an authorization claim. A peer is an actionable Harness Leader only when `capabilities.leader.protocols` contains `dsh-leader/1`.

## Message

The Watcher sends an envelope with `kind: "message"` and this payload:

```json
{
  "protocol": "mesh-watcher/1",
  "type": "watcher_message",
  "origin_role": "watcher",
  "subject": "Optional human label",
  "text": "Message body",
  "audience": "direct",
  "watcher_name": "Wing's iPhone Watcher"
}
```

`audience` is `direct` or `broadcast`. Broadcast is not a transport primitive: the Watcher creates one authenticated envelope for every selected online Leader and records each acknowledgement independently.

An accepted envelope means the remote daemon durably stored it. It does not mean a Harness Session or human has read it.

## Task

Watcher tasks deliberately reuse the Harness Leader contract rather than wrapping it:

```json
{
  "kind": "task",
  "payload": {
    "protocol": "dsh-leader/1",
    "type": "task_start",
    "label": "Inspect deployment",
    "prompt": "Check the failed deployment and report the cause.",
    "workspace_alias": "default",
    "hop_budget": 0,
    "origin_session_id": "ios-watcher",
    "origin_role": "watcher"
  }
}
```

A task targets exactly one Leader. The receiving Leader selects and controls its own bound Harness Session and local Agent Team. The returned `task_result.correlation_id` equals the original task envelope ID. Watchers may also consume correlated `task_progress` envelopes.

If a Watcher receives a `task` envelope, it returns `task_failed` with a diagnostic explaining that the member does not execute tasks, then acknowledges the inbound envelope.
