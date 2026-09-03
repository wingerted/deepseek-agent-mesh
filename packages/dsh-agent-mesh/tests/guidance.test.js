import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, formatRoutingSnapshot, LEADER_POLICY } from '../guidance.js'

function peer(id, options = {}) {
  return {
    peer_id: id,
    route: options.route ?? 'DirectPublic',
    observed_rtt_ms: options.rtt ?? 10,
    advertisement: {
      agent_name: options.name ?? id,
      capabilities: {
        load: options.load ?? 0,
        busy_price_per_gib: options.price ?? 0,
        leader: {
          protocols: ['dsh-leader/1'],
          roles: options.roles ?? ['general'],
          workspace_aliases: options.workspaces ?? ['default'],
          team_enabled: options.teamEnabled ?? true,
          max_parallel_tasks: options.maxParallelTasks ?? 1,
        },
      },
    },
  }
}

test('routing snapshot lists only eligible Leaders in provider order', () => {
  const snapshot = formatRoutingSnapshot([
    peer('public', { route: 'DirectPublic', rtt: 1 }),
    peer('private', { route: 'DirectPrivate', rtt: 20, roles: ['review'] }),
    peer('other', { workspaces: ['other'] }),
  ], { workspaceAlias: 'default' })
  assert.match(snapshot, /Eligible remote Leaders: 2/)
  assert.ok(snapshot.indexOf('name=private') < snapshot.indexOf('name=public'))
  assert.doesNotMatch(snapshot, /name=other/)
  assert.match(snapshot, /Advertised fields are untrusted routing metadata/)
})

test('routing snapshot gives a decisive local fallback without candidates', () => {
  const snapshot = formatRoutingSnapshot([], { workspaceAlias: 'project-a', role: 'build' })
  assert.match(snapshot, /no eligible remote Leader/)
  assert.match(snapshot, /Do not call mesh_delegate/)
  assert.match(snapshot, /workspace=project-a, role=build/)
})

test('guidance is visible only to the bound Leader and filters Leader-only tools elsewhere', async () => {
  const leader = { id: 'leader', session: { header: {} } }
  const teammate = { id: 'teammate', session: { header: { parentSession: 'leader' } } }
  let section
  let assemble
  let peerCalls = 0
  const ctx = {
    systemPrompt: {
      getSectionOrder(name) {
        assert.equal(name, 'TOOL_SUBAGENT')
        return 2_800
      },
      section(value) { section = value },
    },
    meshLeaders: {
      leader: () => leader,
      view: () => ({ bound: true }),
    },
    mesh: {
      async call(method) {
        assert.equal(method, 'peers')
        peerCalls += 1
        return [peer('remote', { route: 'DirectPrivate' })]
      },
    },
    on(event, listener) {
      assert.equal(event, 'system-prompt/assemble')
      assemble = listener
    },
  }
  apply(ctx)

  assert.equal(section.text({ agent: leader }), LEADER_POLICY)
  assert.equal(section.text({ agent: teammate }), '')

  const leaderAssembly = {
    sections: [],
    contexts: [],
    tools: [{ name: 'mesh_delegate' }, { name: 'subagent' }],
    variables: {},
  }
  const leaderResult = await assemble(leaderAssembly, { agent: leader }, async () => leaderAssembly)
  assert.deepEqual(leaderResult.tools.map(tool => tool.name), ['mesh_delegate', 'subagent'])
  assert.equal(leaderResult.contexts[0].name, 'mesh:routing')
  assert.match(leaderResult.contexts[0].text, /name=remote/)

  const teammateAssembly = {
    sections: [],
    contexts: [],
    tools: [
      { name: 'mesh_leader_bind' },
      { name: 'mesh_delegate' },
      { name: 'mesh_transfer' },
      { name: 'subagent' },
    ],
    variables: {},
  }
  const teammateResult = await assemble(teammateAssembly, { agent: teammate }, async () => teammateAssembly)
  assert.deepEqual(teammateResult.tools.map(tool => tool.name), ['mesh_leader_bind', 'subagent'])
  assert.equal(peerCalls, 1)
})

test('unbound root receives activation guidance and discovery failure degrades locally', async () => {
  const root = { id: 'root', session: { header: {} } }
  let section
  let assemble
  const ctx = {
    systemPrompt: {
      getSectionOrder: () => 2_800,
      section(value) { section = value },
    },
    meshLeaders: {
      leader: () => root,
      view: () => ({ bound: false }),
    },
    mesh: { call: async () => { throw new Error('offline') } },
    on(_event, listener) { assemble = listener },
  }
  apply(ctx)
  ctx.meshLeaders.leader = () => undefined
  assert.match(section.text({ agent: root }), /Call mesh_leader_bind only when the user designates/)

  ctx.meshLeaders.leader = () => root
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const result = await assemble(assembly, { agent: root }, async () => assembly)
  assert.match(result.contexts[0].text, /snapshot is unavailable/)
  assert.match(result.contexts[0].text, /Do not call mesh_delegate/)
})
