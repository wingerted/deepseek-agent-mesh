export const name = 'agent-mesh-web'
export const inject = ['connection', 'mesh', 'meshLeaders']

const SNAPSHOT_PATH = '/api/agent-mesh.snapshot'

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  ctx.connection.fetch.register({
    path: SNAPSHOT_PATH,
    methods: ['GET', 'HEAD'],
    async fetch(request) {
      try {
        const snapshot = await buildSnapshot(ctx, resolved, request.signal)
        return jsonResponse(request.method === 'HEAD' ? undefined : snapshot, 200)
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? error
        ctx.logger.warn(`Mesh Web snapshot failed: ${String(error)}`)
        return jsonResponse(request.method === 'HEAD' ? undefined : {
          error: {
            code: 'MESH_UNAVAILABLE',
            message: 'Mesh status is temporarily unavailable.',
          },
        }, 503)
      }
    },
  })
}

export async function buildSnapshot(ctx, config = {}, signal) {
  const resolved = resolveConfig(config)
  const [status, peers] = await Promise.all([
    ctx.mesh.call('status', {}, { signal, timeoutMs: resolved.requestTimeoutMs }),
    ctx.mesh.call('peers', {}, { signal, timeoutMs: resolved.requestTimeoutMs }),
  ])
  const normalizedPeers = (Array.isArray(peers) ? peers : [])
    .slice(0, resolved.maxPeers)
    .map(normalizePeer)
    .filter(Boolean)
    .sort(comparePeers)
  return {
    version: 2,
    captured_at: new Date().toISOString(),
    refresh_interval_ms: resolved.refreshIntervalMs,
    node: normalizeNode(status, ctx.mesh.view?.()),
    leader: normalizeLeaderState(ctx.meshLeaders.view()),
    peers: normalizedPeers,
    topology: {
      node_count: normalizedPeers.length + 1,
      edge_count: normalizedPeers.length,
    },
  }
}

function normalizeNode(status, configured) {
  const value = object(status)
  const meta = object(configured)
  const membership = object(value.membership)
  const certificate = object(membership.certificate)
  const peerId = text(value.peer_id)
  return {
    peer_id: peerId,
    name: text(value.name),
    network_id: text(value.network_id),
    connected_peers: integer(value.connected_peers),
    object_count: integer(value.objects),
    listen_addresses: texts(value.listen_addresses, 32),
    mode: text(meta.mode),
    state_dir: text(meta.state_dir),
    configured_listen_addresses: texts(meta.configured_listen_addresses, 32),
    bootstrap_addresses: texts(meta.bootstrap_addresses, 32),
    allow_peers: texts(meta.allow_peers, 256),
    allow_all_peers: meta.allow_all_peers === true,
    private_networks: texts(meta.private_networks, 32),
    region: text(meta.region),
    zone: text(meta.zone),
    ingress_mbps: number(meta.ingress_mbps),
    egress_mbps: number(meta.egress_mbps),
    idle_price_per_gib: number(meta.idle_price_per_gib),
    busy_price_per_gib: number(meta.busy_price_per_gib),
    allow_source_delete: meta.allow_source_delete === true,
    rendezvous_server: value.rendezvous_server === true,
    membership: {
      enrolled: text(membership.network_id) !== '' && text(certificate.peer_id) === peerId,
      role: text(membership.root_peer_id) === peerId ? 'founder' : 'member',
      root_peer_id: text(membership.root_peer_id),
      certificate_expires_at: epochTimestamp(certificate.expires_at),
    },
    leader: {
      protocols: texts(meta.leader_protocols, 16),
      roles: texts(meta.leader_roles, 32),
      workspaces: texts(meta.leader_workspaces, 32),
      team_enabled: meta.leader_team_enabled === true,
      max_parallel_tasks: integer(meta.leader_max_parallel_tasks),
    },
  }
}

function normalizePeer(peer) {
  const value = object(peer)
  const advertisement = object(value.advertisement)
  const capabilities = object(advertisement.capabilities)
  const leader = object(capabilities.leader)
  const inventory = Array.isArray(value.inventory) ? value.inventory : []
  const peerId = text(value.peer_id)
  if (peerId === '') return undefined
  return {
    peer_id: peerId,
    name: text(advertisement.agent_name),
    network_id: text(advertisement.network_id),
    route: route(value.route),
    rtt_ms: number(value.observed_rtt_ms),
    issued_at: timestamp(advertisement.issued_at),
    expires_at: timestamp(advertisement.expires_at),
    listen_addresses: texts(advertisement.listen_addresses, 32),
    inventory: {
      object_count: inventory.length,
      total_bytes: inventory.reduce((sum, item) => sum + integer(object(item).size), 0),
    },
    capabilities: {
      region: text(capabilities.region),
      zone: text(capabilities.zone),
      currency: text(capabilities.currency),
      private_networks: texts(capabilities.private_networks, 32),
      storage_free_bytes: integer(capabilities.storage_free_bytes),
      ingress_mbps: number(capabilities.ingress_mbps),
      egress_mbps: number(capabilities.egress_mbps),
      load: number(capabilities.load),
      idle_price_per_gib: number(capabilities.idle_price_per_gib),
      busy_price_per_gib: number(capabilities.busy_price_per_gib),
      relay: capabilities.relay === true,
      leader: Object.keys(leader).length === 0 ? undefined : {
        protocols: texts(leader.protocols, 16),
        roles: texts(leader.roles, 32),
        workspaces: texts(leader.workspace_aliases, 32),
        team_enabled: leader.team_enabled === true,
        max_parallel_tasks: integer(leader.max_parallel_tasks),
      },
    },
  }
}

function normalizeLeaderState(value) {
  const state = object(value)
  const leaders = (Array.isArray(state.leaders) ? state.leaders : []).map((leader) => {
    const item = object(leader)
    return {
      session_id: text(item.session_id),
      live: item.live === true,
      status: item.status === 'idle' || item.status === 'running' ? item.status : null,
    }
  }).filter(leader => leader.session_id !== '')
  return {
    bound: leaders.length > 0,
    session_count: leaders.length,
    live_count: leaders.filter(leader => leader.live).length,
    sessions: leaders,
  }
}

function resolveConfig(config) {
  return {
    maxPeers: positiveInteger(config.maxPeers, 256),
    refreshIntervalMs: positiveInteger(config.refreshIntervalMs, 5_000),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs, 3_000),
  }
}

function comparePeers(left, right) {
  const routes = { DirectPrivate: 0, DirectPublic: 1, Relayed: 2, Unknown: 3 }
  return routes[left.route] - routes[right.route]
    || left.name.localeCompare(right.name)
    || left.peer_id.localeCompare(right.peer_id)
}

function jsonResponse(value, status) {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string'
    ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\r\n]/gu, ' ').slice(0, 512)
    : ''
}

function texts(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit).map(text).filter(Boolean) : []
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function integer(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function epochTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined
  return new Date(parsed * 1000).toISOString()
}

function route(value) {
  return value === 'DirectPrivate' || value === 'DirectPublic' || value === 'Relayed'
    ? value
    : 'Unknown'
}
