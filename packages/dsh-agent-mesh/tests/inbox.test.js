import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../inbox.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

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
