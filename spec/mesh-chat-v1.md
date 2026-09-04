# Mesh Leader Chat Protocol v1

`mesh-chat/1` provides a normal, persistent chat-room experience across sovereign DeepSeek Harness Leaders while keeping Agent traffic bounded.

## Roles and topology

- A Watcher hosts the room, stores its ordered timeline, and relays user messages.
- Each participant is an authenticated Mesh peer that advertises Leader capability.
- A Leader owns its local Agent Team and decides what its node can usefully say.
- Leader replies return only to the host. A reply never triggers another reply.

The topology is hub-and-spoke per user message, so one message causes at most one request and one response per selected Leader: `O(N)`, not an all-to-all cascade.

## Room contract

A room fixes its name, optional description, participant peer IDs, maximum user turns, maximum responders per turn, message byte limit, and total stored-message limit. These are safety rails, not visible meeting phases.

The iOS default is 200 user turns, at most five Leader replies per turn, 4 KiB per message, and 2,048 stored messages.

## Prompt

```json
{
  "protocol": "mesh-chat/1",
  "type": "chat_prompt",
  "room_id": "uuid",
  "message_id": "uuid",
  "turn": 7,
  "text": "What should we do next?",
  "context": "recent bounded transcript",
  "contract": {
    "name": "Leaders",
    "participants": ["peer-a", "peer-b"],
    "max_turns": 200,
    "max_responders_per_turn": 2,
    "max_message_bytes": 4096
  }
}
```

## Reply

```json
{
  "protocol": "mesh-chat/1",
  "type": "chat_reply",
  "room_id": "uuid",
  "turn": 7,
  "reply_to": "uuid",
  "body": "This node can validate the Linux package."
}
```

The receiving Harness accepts at most one prompt for `(host, room, turn)`. It may use its local Agent Team, emits at most one final reply, and emits nothing when the final text is `SKIP`.

The Rust host reducer overwrites reply authorship with the authenticated envelope peer, rejects non-participants, stale turns, wrong `reply_to` values, duplicate Leader replies, excess responders, oversized bodies, and exhausted room budgets.
