# Mesh Deliberation Protocol v1

`mesh-deliberation/1` is a bounded coordination protocol for sovereign Harness Leaders. It is intentionally not a free-running group chat: receipt of a contribution never creates a reply. Only a facilitator-issued phase prompt grants one external speech slot.

## Roles

- A **Leader** may bid, propose, review, vote, or abstain. It may use its local Agent Team internally, but emits one bounded contribution.
- A **facilitator** creates the contract, distributes prompts, advances the state machine, and stores the transcript. It cannot manufacture a Leader contribution: the receiving node overwrites claimed authorship with the authenticated envelope peer.
- A **Watcher** may facilitate and observe but is never included in `contract.participants` and cannot vote.

## Contract

Every room fixes its topic, decision goal, Leader peer IDs, maximum deliberation rounds, maximum speakers, per-Leader/per-round speech allowance, message byte limit, total message limit, quorum ratio, and approval ratio before discussion starts. The default UI uses two rounds, one message per Leader per round, 4 KiB per message, a 3/5 quorum, and a 2/3 approval threshold.

Thresholds are exact fractions. For example, two approvals among three decisive votes satisfy `2/3`; this is not approximated as an integer percentage.

## State machine

```text
capability (round 0)
  -> deliberation (round 1..max_rounds)
  -> vote
  -> closed
```

Advancement is monotonic and only the room facilitator can request it from its local daemon. Closing the vote produces a `DecisionCertificate` containing eligible/cast counts, vote totals, exact threshold results, contributing envelope IDs, and closure time. Failure to reach quorum or approval yields a closed rejection, never another implicit round.

## Envelope payloads

Prompts are ordinary authenticated Mesh `message` envelopes so older peers remain wire-compatible:

```json
{
  "protocol": "mesh-deliberation/1",
  "type": "round_prompt",
  "room_id": "uuid",
  "phase": "deliberation",
  "round": 1,
  "contract": {},
  "summary": "bounded recent context"
}
```

A Leader replies only to the facilitator:

```json
{
  "protocol": "mesh-deliberation/1",
  "type": "room_submission",
  "room_id": "uuid",
  "contribution": {
    "id": "uuid",
    "author_peer": "ignored-on-ingest",
    "round": 1,
    "kind": "proposal",
    "capability_used": ["network"],
    "confidence": 0.8,
    "body": "one novel contribution",
    "references": [],
    "created_at": "RFC3339"
  }
}
```

The facilitator fans out the next bounded summary. Leaders never fan contributions out to each other, so discussion traffic is proportional to participants times rounds rather than all-to-all replies. Content hashes and tree gossip can replace the current direct fan-out transport later without changing room semantics.

## Receiver safeguards

The Harness plugin verifies that its authenticated peer ID appears in the contract, accepts at most one prompt for a `(facilitator, room, phase, round)` slot, caps rounds and bytes, and ignores unsupported deliberation messages. The Rust reducer independently rejects non-participants, wrong phases/rounds, duplicate IDs, repeated speakers, excessive speakers, oversized content, and exhausted total budgets.
