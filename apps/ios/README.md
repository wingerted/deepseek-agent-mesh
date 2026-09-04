# DeepSeek Agent Mesh for iOS

This app is a native **Mesh Watcher** that joins the P2P network as an independent signed member. It is neither a thin HTTP remote control nor a Harness Leader:

- the Rust `libp2p` node is linked as a static XCFramework;
- identity, membership, mailbox, and activity history live in the app sandbox;
- only peers advertising `dsh-leader/1` appear as actionable Harness Leaders;
- messages use `mesh-watcher/1`; tasks use the existing `dsh-leader/1` task envelope and correlate returned `task_result` envelopes;
- a broadcast is explicit application-level fan-out with a receipt per Leader;
- inbound tasks are rejected because a Watcher does not execute Agent work.

## Build

Requirements: macOS on Apple Silicon, Xcode 26 (or a compatible full Xcode), and the repository Pixi environment.

```bash
pixi run ios-build-sim
open apps/ios/DeepseekAgentMesh.xcodeproj
```

`ios-build-sim` compiles Rust for a real arm64 iPhone and an Apple Silicon simulator, creates the ignored `apps/ios/Vendor/AgentMeshRust.xcframework`, and builds the app. For a real phone, run `pixi run ios-rust`, then select your development team and device in Xcode.

## Join and use

1. On an existing desktop Leader, create a compact invitation hint with `dsh-mesh invite --ttl 900`.
2. In the iOS app, open **设置**, paste the `mesh1h:...` hint, and tap **加入并启动**. The app resolves the full signed ticket directly from that Leader before redeeming it.
3. Use **总览** for network health and quick actions, **Leader** to inspect capabilities, and **动态** to track delivery and task results.
4. Direct messages target one Leader. “All Leaders” fan-outs to the online set shown in the confirmation dialog. A task always targets exactly one Leader and is executed by that Leader's own Agent Team.

The **协商** tab creates a bounded `mesh-deliberation/1` room. Select the Leader seats, topic, decision goal, and maximum rounds. The Watcher sends one phase prompt per Leader, ingests one authenticated contribution per granted slot, advances phases explicitly, and displays the Rust-generated decision certificate. It facilitates the room but never speaks or votes.

The invite is needed only for first enrollment. The app persists its Ed25519 identity and signed membership under Application Support and automatically reconnects after a successful join.

## Runtime boundary

iOS suspends ordinary apps shortly after they enter the background. The Watcher is therefore online while foreground-active and resumes its durable inbox when it becomes active again. It intentionally does not claim an unrelated background mode.

Mobile builds disable mDNS and discover peers through the signed join ticket's bootstrap addresses, explicit peers, Kademlia, and rendezvous. Direct LAN and WireGuard paths still use the local-network privacy declaration included in the target.
