module.exports = function define(require) {
  const React = require('react')
  const { createElement: h, useEffect, useMemo, useState } = React
  const NS = 'agentMesh.web'

  const zh = {
    tab: 'Mesh 网络', title: 'Agent Mesh', subtitle: '当前 Harness Leader 与其他节点的实时通信视图。',
    refresh: '刷新', refreshing: '正在刷新…', retry: '重试', loading: '正在读取 Mesh 状态…',
    unavailableTitle: '暂时无法读取 Mesh', unavailableBody: '本机 Mesh 守护进程没有响应。请检查插件与守护进程状态后重试。',
    updated: '采集时间', daemon: '本机节点', online: '在线', offline: '离线', leader: 'Leader',
    bound: '已绑定', unbound: '未绑定', live: '会话存活', stale: '会话不可用', peers: '远端节点',
    objects: '对象', topology: '网络拓扑', topologyHelp: '连线表示本机到已发现节点的当前最佳路由。',
    local: '本机', directPrivate: '私网直连', directPublic: '公网直连', relayed: '中继', unknown: '未知路由',
    localMeta: '本机信息', leaderMeta: 'Leader 能力', peerMeta: '节点信息', noPeers: '尚未发现其他节点。加入网络或等待 rendezvous 发现后，这里会自动出现。',
    allowlistWarning: '当前节点未允许任何远端 Peer；除非配置 allowAllPeers，否则只能看到节点，不能接受其传输或任务。',
    peerId: 'Peer ID', name: '名称', network: '网络', mode: '运行模式', region: '区域', zone: '可用区',
    route: '路由', rtt: 'RTT', load: '负载', addresses: '地址', listen: '监听地址', bootstrap: 'Bootstrap',
    allowPolicy: '接入策略', allowAll: '允许所有 Peer', allowListed: '仅允许列表', allowNone: '未允许远端 Peer',
    privateNetworks: '私网标识', bandwidth: '配置带宽（入 / 出）', pricing: '价格（空闲 / 忙时）', currency: '币种',
    storage: '可用存储', inventory: '共享对象', protocols: '协议', roles: '角色', workspaces: '工作区',
    team: '本地 Agent Team', enabled: '启用', disabled: '禁用', parallel: '最大并行任务', session: '会话',
    status: '状态', idle: '空闲', running: '执行中', sourceDelete: '源文件删除', expires: '广告过期时间',
    yes: '是', no: '否', none: '无', nodeCount: '节点数', edgeCount: '连接数',
    rendezvous: 'Rendezvous 服务', membership: '成员身份', signedMembership: '签名成员证书', founder: '创始节点', member: '成员节点', membershipRoot: '成员根 Peer', certificateExpires: '成员证书过期',
  }

  const en = {
    tab: 'Mesh network', title: 'Agent Mesh', subtitle: 'Live communication view of this Harness Leader and its peers.',
    refresh: 'Refresh', refreshing: 'Refreshing…', retry: 'Retry', loading: 'Reading Mesh status…',
    unavailableTitle: 'Mesh is temporarily unavailable', unavailableBody: 'The local Mesh daemon did not respond. Check the plugin and daemon, then retry.',
    updated: 'Captured', daemon: 'Local node', online: 'Online', offline: 'Offline', leader: 'Leader',
    bound: 'Bound', unbound: 'Unbound', live: 'Session live', stale: 'Session unavailable', peers: 'Remote nodes',
    objects: 'Objects', topology: 'Network topology', topologyHelp: 'Edges show the current best route from this node to each discovered peer.',
    local: 'Local', directPrivate: 'Private direct', directPublic: 'Public direct', relayed: 'Relayed', unknown: 'Unknown route',
    localMeta: 'Local metadata', leaderMeta: 'Leader capability', peerMeta: 'Peer metadata', noPeers: 'No peers discovered yet. Join a network or wait for rendezvous discovery.',
    allowlistWarning: 'No remote peer is allowed. Unless allowAllPeers is enabled, peers can be discovered but cannot submit transfers or tasks.',
    peerId: 'Peer ID', name: 'Name', network: 'Network', mode: 'Mode', region: 'Region', zone: 'Zone',
    route: 'Route', rtt: 'RTT', load: 'Load', addresses: 'Addresses', listen: 'Listen addresses', bootstrap: 'Bootstrap',
    allowPolicy: 'Admission policy', allowAll: 'Allow every peer', allowListed: 'Allowlist only', allowNone: 'No remote peers allowed',
    privateNetworks: 'Private network tags', bandwidth: 'Configured bandwidth (in / out)', pricing: 'Price (idle / busy)', currency: 'Currency',
    storage: 'Free storage', inventory: 'Shared objects', protocols: 'Protocols', roles: 'Roles', workspaces: 'Workspaces',
    team: 'Local Agent Team', enabled: 'Enabled', disabled: 'Disabled', parallel: 'Max parallel tasks', session: 'Session',
    status: 'Status', idle: 'Idle', running: 'Running', sourceDelete: 'Source deletion', expires: 'Advertisement expires',
    yes: 'Yes', no: 'No', none: 'None', nodeCount: 'Nodes', edgeCount: 'Connections',
    rendezvous: 'Rendezvous service', membership: 'Membership', signedMembership: 'Signed membership certificate', founder: 'Founder node', member: 'Member node', membershipRoot: 'Membership root peer', certificateExpires: 'Membership certificate expires',
  }

  const CSS = `
    .am-root{color:var(--dsw-alias-label-primary);display:grid;gap:20px;max-width:1100px;padding:4px 0 28px}
    .am-header,.am-section-head,.am-peer-head,.am-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .am-title{font-size:24px;line-height:1.2;margin:0}.am-subtitle,.am-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:6px 0 0}
    .am-actions{align-items:flex-end;display:flex;flex-direction:column;gap:7px}.am-button{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;padding:7px 12px}.am-button:hover{background:var(--dsw-alias-interactive-bg-hover)}.am-button:disabled{cursor:default;opacity:.58}
    .am-updated{color:var(--dsw-alias-label-tertiary);font-size:11px}.am-cards{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr))}.am-card,.am-panel,.am-peer{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:12px}.am-card{display:grid;gap:7px;padding:14px}.am-card-label{color:var(--dsw-alias-label-secondary);font-size:12px}.am-card-value{font-size:19px;font-weight:650;overflow-wrap:anywhere}.am-card-note{color:var(--dsw-alias-label-tertiary);font-size:11px}.am-local-cards{grid-template-columns:repeat(2,minmax(0,1fr))}
    .am-dot{background:var(--dsw-alias-state-success-primary);border-radius:999px;display:inline-block;height:8px;margin-right:7px;width:8px}.am-dot[data-offline=true]{background:var(--dsw-alias-state-error-primary)}
    .am-alert{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-warning-primary);border-radius:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;padding:11px 13px}
    .am-panel{padding:16px}.am-section-title{font-size:16px;margin:0}.am-topology-wrap{display:grid;gap:12px;grid-template-columns:minmax(0,2fr) minmax(180px,1fr);margin-top:14px}.am-topology{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l4);border-radius:10px;min-height:320px;overflow:hidden;width:100%}.am-edge{stroke:var(--dsw-alias-label-tertiary);stroke-width:2}.am-edge[data-route=DirectPrivate]{stroke:var(--dsw-alias-state-success-primary)}.am-edge[data-route=DirectPublic]{stroke:var(--dsw-alias-state-business-primary)}.am-edge[data-route=Relayed]{stroke:var(--dsw-alias-state-warning-primary);stroke-dasharray:5 4}.am-node{fill:var(--dsw-alias-bg-layer-3);stroke:var(--dsw-alias-border-l3);stroke-width:2}.am-node-local{fill:var(--dsw-alias-state-business-primary);stroke:var(--dsw-alias-state-business-primary)}.am-node-label{fill:var(--dsw-alias-label-primary);font-size:11px}.am-node-label-local{fill:var(--dsw-alias-label-primary-inverted);font-weight:650}.am-edge-label{fill:var(--dsw-alias-label-tertiary);font-size:9px}
    .am-legend{display:grid;gap:10px;align-content:start}.am-legend-row{align-items:center;display:flex;font-size:12px;gap:8px}.am-line{border-top:2px solid var(--dsw-alias-label-tertiary);width:26px}.am-line[data-route=DirectPrivate]{border-color:var(--dsw-alias-state-success-primary)}.am-line[data-route=DirectPublic]{border-color:var(--dsw-alias-state-business-primary)}.am-line[data-route=Relayed]{border-color:var(--dsw-alias-state-warning-primary);border-style:dashed}.am-facts{display:grid;gap:10px;grid-template-columns:repeat(3,minmax(0,1fr));margin:14px 0 0}.am-fact{min-width:0}.am-fact dt{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:3px}.am-fact dd{font-size:13px;line-height:1.45;margin:0;overflow-wrap:anywhere}.am-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
    .am-peer-list{display:grid;gap:10px;margin-top:12px}.am-peer{padding:14px}.am-peer-title{font-size:15px;margin:0;overflow-wrap:anywhere}.am-badges{display:flex;flex-wrap:wrap;gap:6px}.am-badge{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l4);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;padding:3px 7px}.am-badge[data-route=DirectPrivate]{color:var(--dsw-alias-state-success-primary)}.am-badge[data-route=DirectPublic]{color:var(--dsw-alias-state-business-primary)}.am-badge[data-route=Relayed]{color:var(--dsw-alias-state-warning-primary)}
    .am-state{align-items:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;display:flex;min-height:220px;justify-content:center;padding:30px;text-align:center}.am-state-inner{max-width:480px}.am-state-title{font-size:18px;margin:0 0 8px}.am-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 4px;text-align:center}
    @media(max-width:800px){.am-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.am-topology-wrap{grid-template-columns:1fr}.am-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:520px){.am-header{align-items:stretch;flex-direction:column}.am-actions{align-items:flex-start}.am-cards,.am-facts,.am-local-cards{grid-template-columns:1fr}.am-topology{min-height:270px}}
  `

  function formatBytes(value) {
    let amount = Number(value) || 0
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1 }
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`
  }

  function formatNumber(value, suffix) {
    return `${(Number(value) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix || ''}`
  }

  function formatTime(value) {
    if (!value) return '—'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
  }

  function list(value, t) { return Array.isArray(value) && value.length > 0 ? value.join(', ') : t('none') }
  function yesNo(value, t) { return t(value ? 'yes' : 'no') }
  function routeLabel(route, t) {
    return t({ DirectPrivate: 'directPrivate', DirectPublic: 'directPublic', Relayed: 'relayed', Unknown: 'unknown' }[route] || 'unknown')
  }

  function Fact({ label, value, code }) {
    return h('div', { className: 'am-fact' }, h('dt', null, label), h('dd', { className: code ? 'am-code' : undefined }, value || '—'))
  }

  function Facts({ rows }) {
    return h('dl', { className: 'am-facts' }, rows.map((row, index) => h(Fact, { key: `${row[0]}-${index}`, label: row[0], value: row[1], code: row[2] })))
  }

  function SummaryCard({ label, value, note, live }) {
    return h('div', { className: 'am-card' },
      h('span', { className: 'am-card-label' }, label),
      h('strong', { className: 'am-card-value' }, live === undefined ? null : h('span', { className: 'am-dot', 'data-offline': live ? undefined : 'true' }), value),
      note ? h('span', { className: 'am-card-note' }, note) : null)
  }

  function Topology({ snapshot, t }) {
    const peers = snapshot.peers.slice(0, 16)
    const cx = 300; const cy = 170; const radius = peers.length < 6 ? 122 : 140
    const points = peers.map((peer, index) => {
      const angle = (Math.PI * 2 * index / Math.max(peers.length, 1)) - Math.PI / 2
      return { peer, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
    })
    const svgChildren = []
    for (const point of points) {
      svgChildren.push(h('line', { key: `edge-${point.peer.peer_id}`, className: 'am-edge', 'data-route': point.peer.route, x1: cx, y1: cy, x2: point.x, y2: point.y }))
      svgChildren.push(h('text', { key: `rtt-${point.peer.peer_id}`, className: 'am-edge-label', x: (cx + point.x) / 2, y: (cy + point.y) / 2 - 4, textAnchor: 'middle' }, `${formatNumber(point.peer.rtt_ms)} ms`))
    }
    svgChildren.push(h('circle', { key: 'local-node', className: 'am-node am-node-local', cx, cy, r: 31 }))
    svgChildren.push(h('text', { key: 'local-label', className: 'am-node-label am-node-label-local', x: cx, y: cy + 4, textAnchor: 'middle' }, t('local')))
    for (const point of points) {
      const label = point.peer.name || point.peer.peer_id.slice(0, 9)
      svgChildren.push(h('circle', { key: `node-${point.peer.peer_id}`, className: 'am-node', cx: point.x, cy: point.y, r: 23 }))
      svgChildren.push(h('text', { key: `label-${point.peer.peer_id}`, className: 'am-node-label', x: point.x, y: point.y + 38, textAnchor: 'middle' }, label.slice(0, 18)))
    }
    const legends = [['DirectPrivate', 'directPrivate'], ['DirectPublic', 'directPublic'], ['Relayed', 'relayed'], ['Unknown', 'unknown']]
    return h('section', { className: 'am-panel', 'aria-labelledby': 'am-topology-title' },
      h('div', { className: 'am-section-head' }, h('div', null,
        h('h3', { id: 'am-topology-title', className: 'am-section-title' }, t('topology')),
        h('p', { className: 'am-muted' }, t('topologyHelp'))),
        h('span', { className: 'am-muted' }, `${t('nodeCount')}: ${snapshot.topology.node_count} · ${t('edgeCount')}: ${snapshot.topology.edge_count}`)),
      h('div', { className: 'am-topology-wrap' },
        h('svg', { className: 'am-topology', role: 'img', 'aria-label': t('topology'), viewBox: '0 0 600 340', preserveAspectRatio: 'xMidYMid meet' }, svgChildren),
        h('div', { className: 'am-legend' }, legends.map(([route, key]) => h('div', { className: 'am-legend-row', key: route }, h('span', { className: 'am-line', 'data-route': route }), h('span', null, t(key))))))
    )
  }

  function LocalMetadata({ snapshot, t }) {
    const node = snapshot.node; const leader = snapshot.leader
    const policy = node.membership.enrolled ? t('signedMembership') : node.allow_all_peers ? t('allowAll') : node.allow_peers.length > 0 ? `${t('allowListed')} (${node.allow_peers.length})` : t('allowNone')
    return h('div', { className: 'am-cards am-local-cards' },
      h('section', { className: 'am-panel' }, h('h3', { className: 'am-section-title' }, t('localMeta')), h(Facts, { rows: [
        [t('name'), node.name], [t('peerId'), node.peer_id, true], [t('network'), node.network_id], [t('mode'), node.mode],
        [t('region'), node.region], [t('zone'), node.zone], [t('listen'), list(node.listen_addresses, t), true],
        [t('bootstrap'), list(node.bootstrap_addresses, t), true], [t('allowPolicy'), policy], [t('privateNetworks'), list(node.private_networks, t)],
        [t('rendezvous'), yesNo(node.rendezvous_server, t)], [t('membership'), node.membership.enrolled ? t(node.membership.role) : t('none')],
        [t('membershipRoot'), node.membership.root_peer_id, true], [t('certificateExpires'), formatTime(node.membership.certificate_expires_at)],
        [t('bandwidth'), `${formatNumber(node.ingress_mbps)} / ${formatNumber(node.egress_mbps)} Mbps`],
        [t('pricing'), `${formatNumber(node.idle_price_per_gib)} / ${formatNumber(node.busy_price_per_gib)}`], [t('sourceDelete'), yesNo(node.allow_source_delete, t)],
      ] })),
      h('section', { className: 'am-panel' }, h('h3', { className: 'am-section-title' }, t('leaderMeta')), h(Facts, { rows: [
        [t('status'), leader.status ? t(leader.status) : '—'], [t('session'), leader.session_id, true], [t('protocols'), list(node.leader.protocols, t)],
        [t('roles'), list(node.leader.roles, t)], [t('workspaces'), list(node.leader.workspaces, t)], [t('team'), t(node.leader.team_enabled ? 'enabled' : 'disabled')],
        [t('parallel'), String(node.leader.max_parallel_tasks)],
      ] }))
    )
  }

  function PeerCard({ peer, t }) {
    const cap = peer.capabilities; const leader = cap.leader
    const rows = [
      [t('peerId'), peer.peer_id, true], [t('network'), peer.network_id], [t('region'), cap.region], [t('zone'), cap.zone],
      [t('load'), `${formatNumber((cap.load || 0) * 100)}%`], [t('bandwidth'), `${formatNumber(cap.ingress_mbps)} / ${formatNumber(cap.egress_mbps)} Mbps`],
      [t('pricing'), `${formatNumber(cap.idle_price_per_gib)} / ${formatNumber(cap.busy_price_per_gib)} ${cap.currency || ''}`],
      [t('storage'), formatBytes(cap.storage_free_bytes)], [t('inventory'), `${peer.inventory.object_count} · ${formatBytes(peer.inventory.total_bytes)}`],
      [t('privateNetworks'), list(cap.private_networks, t)], [t('addresses'), list(peer.listen_addresses, t), true], [t('expires'), formatTime(peer.expires_at)],
    ]
    if (leader) rows.push([t('protocols'), list(leader.protocols, t)], [t('roles'), list(leader.roles, t)], [t('workspaces'), list(leader.workspaces, t)], [t('team'), t(leader.team_enabled ? 'enabled' : 'disabled')], [t('parallel'), String(leader.max_parallel_tasks)])
    return h('article', { className: 'am-peer' },
      h('div', { className: 'am-peer-head' }, h('h4', { className: 'am-peer-title' }, peer.name || peer.peer_id),
        h('div', { className: 'am-badges' }, h('span', { className: 'am-badge', 'data-route': peer.route }, routeLabel(peer.route, t)), h('span', { className: 'am-badge' }, `${formatNumber(peer.rtt_ms)} ms`), leader ? h('span', { className: 'am-badge' }, t('leader')) : null)),
      h(Facts, { rows }))
  }

  function Dashboard({ snapshot, refreshing, onRefresh, t }) {
    const node = snapshot.node; const leader = snapshot.leader
    return h('main', { className: 'am-root' },
      h('header', { className: 'am-header' }, h('div', null, h('h2', { className: 'am-title' }, t('title')), h('p', { className: 'am-subtitle' }, t('subtitle'))),
        h('div', { className: 'am-actions' }, h('button', { type: 'button', className: 'am-button', disabled: refreshing, onClick: onRefresh }, t(refreshing ? 'refreshing' : 'refresh')), h('span', { className: 'am-updated' }, `${t('updated')}: ${formatTime(snapshot.captured_at)}`))),
      h('div', { className: 'am-cards' },
        h(SummaryCard, { label: t('daemon'), value: t('online'), note: node.name || node.peer_id, live: true }),
        h(SummaryCard, { label: t('leader'), value: t(leader.bound ? 'bound' : 'unbound'), note: t(leader.live ? 'live' : 'stale'), live: leader.bound && leader.live }),
        h(SummaryCard, { label: t('peers'), value: String(node.connected_peers), note: `${snapshot.topology.edge_count} ${t('edgeCount')}` }),
        h(SummaryCard, { label: t('objects'), value: String(node.object_count), note: `${snapshot.peers.reduce((sum, peer) => sum + peer.inventory.object_count, 0)} ${t('peers')}` })),
      !node.membership.enrolled && !node.allow_all_peers && node.allow_peers.length === 0 ? h('div', { className: 'am-alert', role: 'status' }, t('allowlistWarning')) : null,
      h(Topology, { snapshot, t }), h(LocalMetadata, { snapshot, t }),
      h('section', { className: 'am-panel', 'aria-labelledby': 'am-peer-title' }, h('div', { className: 'am-section-head' }, h('h3', { id: 'am-peer-title', className: 'am-section-title' }, t('peerMeta')), h('span', { className: 'am-muted' }, String(snapshot.peers.length))),
        snapshot.peers.length === 0 ? h('div', { className: 'am-empty' }, t('noPeers')) : h('div', { className: 'am-peer-list' }, snapshot.peers.map(peer => h(PeerCard, { key: peer.peer_id, peer, t }))))
    )
  }

  function MeshNetworkTab({ loadSnapshot, t }) {
    const [request, setRequest] = useState(0)
    const [state, setState] = useState({ status: 'loading', snapshot: undefined })
    useEffect(() => {
      let disposed = false; let busy = false; const controller = new AbortController()
      const load = async () => {
        if (busy || disposed) return
        busy = true
        setState(current => ({ ...current, status: current.snapshot ? 'refreshing' : 'loading' }))
        try {
          const snapshot = await loadSnapshot(controller.signal)
          if (!disposed) setState({ status: 'ready', snapshot })
        } catch (error) {
          if (!disposed && !controller.signal.aborted) setState(current => ({ status: 'error', snapshot: current.snapshot, error: String(error) }))
        } finally { busy = false }
      }
      void load()
      const interval = setInterval(load, Math.max(1000, state.snapshot?.refresh_interval_ms || 5000))
      return () => { disposed = true; controller.abort(); clearInterval(interval) }
    }, [loadSnapshot, request])
    const refresh = useMemo(() => () => setRequest(value => value + 1), [])
    if (state.snapshot) return h(Dashboard, { snapshot: state.snapshot, refreshing: state.status === 'refreshing', onRefresh: refresh, t })
    if (state.status === 'error') return h('div', { className: 'am-state', role: 'alert' }, h('div', { className: 'am-state-inner' }, h('h2', { className: 'am-state-title' }, t('unavailableTitle')), h('p', { className: 'am-muted' }, t('unavailableBody')), h('button', { type: 'button', className: 'am-button', onClick: refresh }, t('retry'))))
    return h('div', { className: 'am-state', role: 'status' }, h('div', { className: 'am-state-inner' }, t('loading')))
  }

  const inject = ['slots', 'locale']
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-mesh-web: dictionaries')
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-agent-mesh-web'; style.textContent = CSS; document.head.appendChild(style)
      return () => style.remove()
    }, 'agent-mesh-web: styles')
    const t = ctx.locale.bind(NS)
    const loadSnapshot = async signal => {
      const response = await fetch('/api/agent-mesh.snapshot', { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
      if (!response.ok) throw new Error(`Mesh snapshot HTTP ${response.status}`)
      return response.json()
    }
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab', id: 'mesh', order: 20, label: () => t('tab'), locale: NS, inject: () => ({ loadSnapshot }),
    }, MeshNetworkTab))
  }

  return { name: 'agent-mesh-web-client', inject, apply, MeshNetworkTab }
}
