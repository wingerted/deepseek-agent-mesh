import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MeshLeaderRuntime } from '../leader.js'

function runtime(sessionIds = [], agents = new Map()) {
  const value = Object.create(MeshLeaderRuntime.prototype)
  value.leaderSessionIds = new Set(sessionIds)
  value.bindingQueue = Promise.resolve()
  value.inboundTasks = new Map()
  value.runtimeCtx = { agents: { get: sessionId => agents.get(sessionId) } }
  return value
}

test('bound Leader Sessions resume through the Harness agent lookup', async () => {
  const live = { id: 'session-live', status: 'idle' }
  const agents = new Map([['session-live', live]])
  const resumed = []
  const warnings = []
  const value = runtime(['session-live', 'session-cold', 'session-missing'], agents)
  value.runtimeCtx.typert = {
    lookups: {
      get: key => key === 'agent' ? {
        async resolve(sessionId) {
          resumed.push(sessionId)
          if (sessionId === 'session-missing') throw new Error('not found')
          const agent = { id: sessionId, status: 'idle' }
          agents.set(sessionId, agent)
          return agent
        },
      } : undefined,
    },
  }
  value.runtimeCtx.logger = { warn: message => warnings.push(message) }

  await value.wakeBoundLeaders()

  assert.deepEqual(resumed, ['session-cold', 'session-missing'])
  assert.deepEqual(value.leaders().map(agent => agent.id), ['session-live', 'session-cold'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /session-missing.*not found/)
})

test('Leader status is lossless JSON with multiple live and stale Sessions', () => {
  const current = { id: 'session-b', status: 'running' }
  const view = runtime(
    ['session-a', 'session-b'],
    new Map([['session-b', current]]),
  ).view(current)
  assert.deepEqual(view, {
    bound: true,
    leader_session_ids: ['session-a', 'session-b'],
    live_count: 1,
    leaders: [
      { session_id: 'session-a', live: false, status: null },
      { session_id: 'session-b', live: true, status: 'running' },
    ],
    current_session_id: 'session-b',
    current_session_is_leader: true,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('concurrent bindings add root Sessions and persist the version 2 set', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'mesh-leaders-'))
  try {
    const value = runtime(['session-a'])
    value.ctx = { mesh: { stateDir } }
    const sessionB = { id: 'session-b', status: 'idle', session: { header: {} } }
    const sessionC = { id: 'session-c', status: 'idle', session: { header: {} } }
    value.runtimeCtx.agents.get = sessionId => new Map([
      ['session-b', sessionB],
      ['session-c', sessionC],
    ]).get(sessionId)
    const [, view] = await Promise.all([value.bind(sessionB), value.bind(sessionC)])
    assert.deepEqual(view.leader_session_ids, ['session-a', 'session-b', 'session-c'])
    assert.equal(view.current_session_is_leader, true)
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'leader.json'), 'utf8')), {
      version: 2,
      leader_session_ids: ['session-a', 'session-b', 'session-c'],
    })
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('load accepts the version 1 singleton state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'mesh-leaders-v1-'))
  try {
    await writeFile(join(stateDir, 'leader.json'), JSON.stringify({
      version: 1,
      leader_session_id: 'session-a',
    }))
    const value = runtime()
    value.ctx = { mesh: { stateDir } }
    await value.load()
    assert.deepEqual([...value.leaderSessionIds], ['session-a'])
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('inbound task ownership and hop budgets are isolated per Leader Session', async () => {
  const leaderA = { id: 'session-a' }
  const leaderB = { id: 'session-b' }
  const value = runtime(['session-a', 'session-b'])
  value.beginInboundTask(leaderA, 'task-a', 1)
  value.beginInboundTask(leaderB, 'task-b', 3)
  assert.equal(value.outboundHopBudget(leaderA, 9), 0)
  assert.equal(value.outboundHopBudget(leaderB, 9), 2)
  value.taskController = { complete: async taskId => taskId }
  assert.throws(() => value.complete(leaderA, 'task-b', {}), /not assigned to this Leader Session/)
  assert.equal(await value.complete(leaderB, 'task-b', {}), 'task-b')
})
