import { randomUUID } from 'node:crypto'
import { meshCall } from '../packages/mesh-rpc/src/index.js'

const stateDir = process.argv[2]
if (!stateDir) throw new Error('usage: node tooling/chat-smoke.mjs <state-dir>')

const status = await meshCall(stateDir, 'status')
const peers = await meshCall(stateDir, 'peers')
const participants = peers
  .filter(peer => peer.advertisement?.capabilities?.leader?.protocols?.includes('mesh-chat/1'))
  .slice(0, 3)
  .map(peer => peer.peer_id)
if (participants.length === 0) throw new Error('no mesh-chat/1 Leader is online')

let room = await meshCall(stateDir, 'chat.create', {
  contract: {
    name: 'Mesh smoke chat',
    description: 'Validate bounded chat storage and authenticated replies',
    participants,
    max_turns: 10,
    max_responders_per_turn: participants.length,
    max_message_bytes: 4096,
    max_total_messages: 64,
  },
})
room = await meshCall(stateDir, 'chat.post', { room_id: room.id, body: 'Hello Leaders' })
const prompt = room.messages.at(-1)

const envelope = {
  id: randomUUID(),
  network_id: status.network_id,
  from_peer: participants[0],
  to_peer: status.peer_id,
  kind: 'message',
  correlation_id: null,
  payload: {
    protocol: 'mesh-chat/1',
    type: 'chat_reply',
    room_id: room.id,
    turn: room.turn,
    reply_to: prompt.id,
    body: 'Hello from a Leader',
  },
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
}
room = await meshCall(stateDir, 'chat.ingest', { envelope })
console.log(JSON.stringify({ room_id: room.id, turn: room.turn, messages: room.messages.length }, null, 2))
