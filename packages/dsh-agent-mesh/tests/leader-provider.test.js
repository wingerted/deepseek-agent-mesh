import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, selectLeaderPeer } from '../leader-provider.js'

function peer(id, options = {}) {
  return {
    peer_id: id,
    route: options.route ?? 'DirectPublic',
    observed_rtt_ms: options.rtt ?? 10,
    advertisement: {
      capabilities: {
        load: options.load ?? 0,
        busy_price_per_gib: 0,
        leader: {
          protocols: ['dsh-leader/1'],
          roles: options.roles ?? ['general'],
          workspace_aliases: options.workspaces ?? ['default'],
          team_enabled: true,
          max_parallel_tasks: 1,
        },
      },
    },
  }
}

test('selectLeaderPeer filters capabilities and prefers a private low-latency route', () => {
  const selected = selectLeaderPeer([
    peer('public', { route: 'DirectPublic', rtt: 5 }),
    peer('private', { route: 'DirectPrivate', rtt: 20 }),
    peer('wrong-workspace', { workspaces: ['other'] }),
  ], { workspaceAlias: 'default' })
  assert.equal(selected, 'private')
})

test('provider publishes a remote SubagentRun and collects the correlated result', async () => {
  let provider
  const calls = []
  const ctx = {
    logger: { warn() {} },
    meshLeaders: { assertLeader() {}, outboundHopBudget() { return 0 } },
    subagents: { registerProvider(value) { provider = value } },
    mesh: {
      async call(method, params) {
        calls.push({ method, params })
        if (method === 'peers') return [peer('leader-b', { route: 'DirectPrivate' })]
        if (method === 'send') return { id: '7f319aba-d6c2-4ca6-9a6b-80f239abc29e', accepted: true }
        if (method === 'inbox.list') return [{
          id: 'result-envelope',
          from_peer: 'leader-b',
          correlation_id: '7f319aba-d6c2-4ca6-9a6b-80f239abc29e',
          payload: { output: [{ type: 'text', text: 'done' }], stop_reason: 'completed' },
        }]
        if (method === 'inbox.ack') return { acked: true }
        throw new Error(`unexpected call ${method}`)
      },
    },
  }
  apply(ctx, { pollIntervalMs: 100 })
  const controller = new AbortController()
  const run = await provider.start({
    label: 'delegate',
    prompt: [{ type: 'text', text: 'work' }],
    parent: { id: 'leader-a' },
    signal: controller.signal,
  })
  assert.equal(run.localAgent, undefined)
  assert.match(run.id, /^mesh-/)
  assert.deepEqual(await run.result, {
    output: [{ type: 'text', text: 'done' }],
    stopReason: 'completed',
  })
  await run.dispose()
  const start = calls.find(call => call.method === 'send')
  assert.equal(start.params.kind, 'task')
  assert.equal(start.params.payload.hop_budget, 0)
  assert.ok(calls.some(call => call.method === 'inbox.ack'))
})

test('provider propagates caller cancellation as a task_cancel envelope', async () => {
  let provider
  const sends = []
  const ctx = {
    logger: { warn() {} },
    meshLeaders: { assertLeader() {}, outboundHopBudget() { return 0 } },
    subagents: { registerProvider(value) { provider = value } },
    mesh: {
      async call(method, params) {
        if (method === 'peers') return [peer('leader-b')]
        if (method === 'send') {
          sends.push(params)
          return { id: params.kind === 'task' ? '9d5d2901-c80d-49c8-a054-31ab98b05f5d' : 'cancel-envelope' }
        }
        if (method === 'inbox.list') return []
        throw new Error(`unexpected call ${method}`)
      },
    },
  }
  apply(ctx, { pollIntervalMs: 100 })
  const controller = new AbortController()
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'work' }],
    parent: { id: 'leader-a' },
    signal: controller.signal,
  })
  controller.abort('stop')
  assert.deepEqual(await run.result, { output: [], stopReason: 'aborted' })
  await run.dispose()
  assert.ok(sends.some(params => params.kind === 'task_cancel'
    && params.correlation_id === '9d5d2901-c80d-49c8-a054-31ab98b05f5d'))
})
