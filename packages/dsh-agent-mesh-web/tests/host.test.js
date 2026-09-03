import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, buildSnapshot } from '../index.js'

function context(overrides = {}) {
  const status = {
    peer_id: 'local-peer', name: 'local-node', network_id: 'mesh-a', connected_peers: 1,
    objects: 2, listen_addresses: ['/ip4/127.0.0.1/tcp/41001'],
  }
  const peers = [{
    peer_id: 'remote-peer', route: 'DirectPrivate', observed_rtt_ms: 8.25,
    advertisement: {
      agent_name: 'remote-node', network_id: 'mesh-a', issued_at: '2026-09-03T00:00:00Z',
      expires_at: '2026-09-03T01:00:00Z', listen_addresses: ['/ip4/10.0.0.2/tcp/41001'],
      capabilities: {
        region: 'cn-east', zone: 'az-1', private_networks: ['vpc-a'], currency: 'CNY',
        storage_free_bytes: 4096, ingress_mbps: 1000, egress_mbps: 100, load: 0.2,
        idle_price_per_gib: 0.3, busy_price_per_gib: 0.5, relay: false,
        leader: { protocols: ['dsh-leader/1'], roles: ['review'], workspace_aliases: ['project-a'], team_enabled: true, max_parallel_tasks: 3 },
      },
    },
    inventory: [{ size: 100 }, { size: 300 }],
  }]
  return {
    mesh: {
      call: async method => method === 'status' ? status : peers,
      view: () => ({
        mode: 'managed', state_dir: '/state', configured_listen_addresses: [], bootstrap_addresses: [],
        allow_peers: ['remote-peer'], allow_all_peers: false, private_networks: ['vpc-a'],
        region: 'cn-east', zone: 'az-1', ingress_mbps: 500, egress_mbps: 50,
        idle_price_per_gib: 0.1, busy_price_per_gib: 0.2, leader_protocols: ['dsh-leader/1'],
        leader_roles: ['coding'], leader_workspaces: ['project-a'], leader_team_enabled: true,
        leader_max_parallel_tasks: 2, allow_source_delete: false,
      }),
    },
    meshLeaders: { view: () => ({ bound: true, live: true, leader_session_id: 'session-1', status: 'idle' }) },
    logger: { warn() {} },
    ...overrides,
  }
}

test('buildSnapshot returns bounded browser-safe node, leader and topology metadata', async () => {
  const snapshot = await buildSnapshot(context(), { maxPeers: 10, refreshIntervalMs: 2000, requestTimeoutMs: 1000 })
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.node.peer_id, 'local-peer')
  assert.equal(snapshot.node.leader.max_parallel_tasks, 2)
  assert.equal(snapshot.leader.session_id, 'session-1')
  assert.equal(snapshot.peers[0].route, 'DirectPrivate')
  assert.equal(snapshot.peers[0].inventory.total_bytes, 400)
  assert.deepEqual(snapshot.peers[0].capabilities.leader.roles, ['review'])
  assert.deepEqual(snapshot.topology, { node_count: 2, edge_count: 1 })
})

test('apply registers an exact GET/HEAD snapshot endpoint', async () => {
  let route
  const ctx = context({ connection: { fetch: { register(value) { route = value } } } })
  apply(ctx, { refreshIntervalMs: 2500 })
  assert.equal(route.path, '/api/agent-mesh.snapshot')
  assert.deepEqual(route.methods, ['GET', 'HEAD'])
  const get = await route.fetch(new Request('http://localhost/api/agent-mesh.snapshot'))
  assert.equal(get.status, 200)
  assert.equal(get.headers.get('cache-control'), 'no-store')
  assert.equal((await get.json()).refresh_interval_ms, 2500)
  const head = await route.fetch(new Request('http://localhost/api/agent-mesh.snapshot', { method: 'HEAD' }))
  assert.equal(await head.text(), '')
})

test('endpoint exposes a generic failure without leaking daemon details', async () => {
  let route
  const warnings = []
  const ctx = context({
    mesh: { call: async () => { throw new Error('secret socket path') } },
    connection: { fetch: { register(value) { route = value } } },
    logger: { warn(value) { warnings.push(value) } },
  })
  apply(ctx)
  const response = await route.fetch(new Request('http://localhost/api/agent-mesh.snapshot'))
  assert.equal(response.status, 503)
  const body = await response.text()
  assert.match(body, /MESH_UNAVAILABLE/)
  assert.doesNotMatch(body, /secret socket path/)
  assert.equal(warnings.length, 1)
})
