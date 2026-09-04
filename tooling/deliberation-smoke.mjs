import { randomUUID } from 'node:crypto'
import { meshCall } from '../packages/dsh-agent-mesh/lib/rpc.js'

const stateDir = process.argv[2]
if (!stateDir) throw new Error('usage: node tooling/deliberation-smoke.mjs <state-dir>')

const peers = await meshCall(stateDir, 'peers')
const participants = peers
  .filter(peer => peer.advertisement?.capabilities?.leader?.protocols?.includes('dsh-leader/1'))
  .slice(0, 3)
  .map(peer => peer.peer_id)
if (participants.length < 2) throw new Error('the smoke test requires at least two visible Leaders')

let room = await meshCall(stateDir, 'room.create', {
  contract: {
    topic: '选择下一版 Mesh 协商传输策略',
    goal: '两轮内决定采用树形 gossip 还是逐节点 fan-out',
    participants,
    max_rounds: 2,
    max_speakers: participants.length,
    messages_per_leader_per_round: 1,
    max_message_bytes: 4096,
    max_total_messages: 16,
    quorum_numerator: 3,
    quorum_denominator: 5,
    approval_numerator: 2,
    approval_denominator: 3,
  },
})

for (const [index, peer] of participants.entries()) {
  room = await submit(peer, 0, 'capability_bid', index === 0
    ? '具备 Rust/libp2p 实现与协议状态机验证能力；可以提出方案并执行。'
    : '具备分布式系统审查能力；适合检查流量上界、故障恢复与一致性风险。')
}
room = await meshCall(stateDir, 'room.advance', { room_id: room.id })
for (const [index, peer] of participants.entries()) {
  room = await submit(peer, 1, 'proposal', index === 0
    ? '小房间保留逐节点投递，超过阈值后切换有界 fanout 的树形 gossip。'
    : '建议房间逻辑广播与物理传输解耦，并以消息哈希做去重和按需拉取。')
}
room = await meshCall(stateDir, 'room.advance', { room_id: room.id })
for (const [index, peer] of participants.entries()) {
  room = await submit(peer, 2, 'review', index === 0
    ? '树形转发需要轮次级视图和父节点失效后的确定性重选。'
    : '必须保留每 Leader 每轮一条、4 KiB 与总消息数三层硬预算。')
}
room = await meshCall(stateDir, 'room.advance', { room_id: room.id })
for (const peer of participants) room = await submit(peer, 2, 'vote', 'APPROVE：采用带小房间直投回退的树形 gossip。', 'approve')
room = await meshCall(stateDir, 'room.advance', { room_id: room.id })

console.log(JSON.stringify({ room_id: room.id, phase: room.phase, decision: room.decision }, null, 2))

async function submit(peer, round, kind, body, vote) {
  const now = new Date()
  const envelope = {
    id: randomUUID(),
    network_id: 'default',
    from_peer: peer,
    to_peer: room.facilitator_peer,
    kind: 'message',
    correlation_id: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    payload: {
      protocol: 'mesh-deliberation/1',
      type: 'room_submission',
      room_id: room.id,
      contribution: {
        id: randomUUID(),
        author_peer: peer,
        round,
        kind,
        capability_used: ['distributed-systems'],
        confidence: 0.8,
        body,
        references: [],
        ...(vote ? { vote } : {}),
        created_at: now.toISOString(),
      },
    },
  }
  return meshCall(stateDir, 'room.ingest', { envelope })
}
