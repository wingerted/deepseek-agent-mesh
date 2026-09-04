import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, deliberationPrompt, isDeliberationPrompt, senderRoleLabel } from '../inbox.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('classifies iOS watcher metadata without granting Leader authority', () => {
  assert.equal(senderRoleLabel({ payload: { protocol: 'mesh-watcher/1', origin_role: 'watcher' } }), 'Watcher')
  assert.equal(senderRoleLabel({ payload: { protocol: 'dsh-leader/1', origin_role: 'leader' } }), 'Leader')
  assert.equal(senderRoleLabel({ payload: {} }), 'Peer')
})

test('recognizes bounded deliberation prompts and tells the Leader to emit once', () => {
  const envelope = {
    id: 'round-a', kind: 'message', from_peer: 'watcher',
    payload: {
      protocol: 'mesh-deliberation/1', type: 'round_prompt', room_id: 'room-a',
      phase: 'vote', round: 2,
      contract: { topic: 'Choose transport', goal: 'Decision', max_rounds: 2, max_message_bytes: 1024 },
    },
  }
  assert.equal(isDeliberationPrompt(envelope), true)
  assert.match(deliberationPrompt(envelope), /APPROVE, REJECT, or ABSTAIN/)
  assert.match(deliberationPrompt(envelope), /emit only the final bounded contribution/)
})

test('a deliberation slot produces exactly one structured reply to its facilitator', async () => {
  const prompt = {
    id: 'round-a', kind: 'message', from_peer: 'facilitator',
    payload: {
      protocol: 'mesh-deliberation/1', type: 'room_open',
      room_id: '7bc46428-1533-466c-8c3b-d7e9090cb440', phase: 'capability', round: 0,
      contract: {
        topic: 'Choose transport', goal: 'Decide once', max_rounds: 2,
        max_message_bytes: 1024, participants: ['local-peer'],
      },
    },
  }
  let followed
  let onEvent
  let dispose
  const sent = []
  const acked = []
  const leader = {
    id: 'leader-session', status: 'idle', inbox: { remove: () => false }, cancel() {},
    followup(message) { followed = message },
  }
  const ctx = {
    logger: { warn(value) { assert.fail(value) } },
    mesh: { async call(method, params) {
      if (method === 'inbox.list') return [prompt]
      if (method === 'status') return { peer_id: 'local-peer' }
      if (method === 'send') { sent.push(params); return { id: 'reply-a' } }
      if (method === 'inbox.ack') { acked.push(params.id); return { acked: true } }
      throw new Error(`unexpected Mesh call ${method}`)
    } },
    meshLeaders: {
      leaders: () => [leader], beginInboundTask() {}, endInboundTask() {},
      registerTaskController: () => () => {},
    },
    on(event, listener) { assert.equal(event, 'session/event'); onEvent = listener },
    effect(factory) { dispose = factory() },
  }

  apply(ctx, { enabled: true, pollIntervalMs: 60_000 })
  await tick()
  assert.ok(followed)
  onEvent(leader, { type: 'user/message', data: { id: followed.id } })
  onEvent(leader, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I can review transport safety.' }] } } })
  onEvent(leader, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await tick()
  await tick()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].peer_id, 'facilitator')
  assert.equal(sent[0].payload.type, 'room_submission')
  assert.equal(sent[0].payload.contribution.kind, 'capability_bid')
  assert.equal(sent[0].payload.contribution.body, 'I can review transport safety.')
  assert.deepEqual(acked, ['round-a'])
  await dispose()
})

test('inbox dispatches concurrent tasks to distinct idle Leader Sessions', async () => {
  const tasks = [
    { id: 'task-a', kind: 'task', from_peer: 'peer-a', payload: { prompt: 'A', hop_budget: 1 } },
    { id: 'task-b', kind: 'task', from_peer: 'peer-b', payload: { prompt: 'B', hop_budget: 2 } },
  ]
  const followed = new Map()
  const leaders = ['leader-a', 'leader-b'].map(id => ({
    id,
    status: 'idle',
    inbox: { remove: () => false },
    followup(message) { followed.set(id, message) },
    cancel() {},
  }))
  const begun = []
  const ended = []
  const sent = []
  const acked = []
  let onEvent
  let dispose
  const ctx = {
    logger: { warn(value) { assert.fail(value) } },
    mesh: {
      async call(method, params) {
        if (method === 'inbox.list') return tasks
        if (method === 'send') { sent.push(params); return { id: `result-${params.correlation_id}` } }
        if (method === 'inbox.ack') { acked.push(params.id); return { acked: true } }
        throw new Error(`unexpected Mesh call ${method}`)
      },
    },
    meshLeaders: {
      leaders: () => leaders,
      beginInboundTask(leader, taskId, hopBudget) { begun.push([leader.id, taskId, hopBudget]) },
      endInboundTask(taskId) { ended.push(taskId) },
      registerTaskController() { return () => {} },
    },
    on(event, listener) {
      assert.equal(event, 'session/event')
      onEvent = listener
    },
    effect(factory) { dispose = factory() },
  }

  apply(ctx, { enabled: true, pollIntervalMs: 60_000 })
  await tick()
  assert.deepEqual(begun, [
    ['leader-a', 'task-a', 1],
    ['leader-b', 'task-b', 2],
  ])
  assert.deepEqual([...followed.keys()], ['leader-a', 'leader-b'])

  for (const [index, leader] of leaders.entries()) {
    const message = followed.get(leader.id)
    onEvent(leader, { type: 'user/message', data: { id: message.id } })
    onEvent(leader, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `done-${index}` }] } } })
    onEvent(leader, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  await tick()
  await tick()
  assert.deepEqual(sent.map(item => item.correlation_id).sort(), ['task-a', 'task-b'])
  assert.deepEqual(acked.sort(), ['task-a', 'task-b'])
  assert.deepEqual(ended.sort(), ['task-a', 'task-b'])
  await dispose()
})
