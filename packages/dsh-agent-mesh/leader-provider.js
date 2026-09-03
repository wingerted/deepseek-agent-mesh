const LEADER_PROTOCOL = 'dsh-leader/1'
const MAX_TASK_BYTES = 512 * 1024
const KNOWN_STOP_REASONS = new Set(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

export const name = 'agent-mesh-leader-provider'
export const inject = ['mesh', 'meshLeaders', 'subagents']

export function selectLeaderPeer(peers, options = {}) {
  if (options.peerId) {
    const advertised = peers.find(peer => peer.peer_id === options.peerId)
    if (advertised !== undefined) assertEligible(advertised, options)
    return options.peerId
  }
  const candidates = rankEligibleLeaderPeers(peers, options)
  if (candidates.length === 0) {
    throw new Error(`no eligible ${LEADER_PROTOCOL} peer is currently advertised`)
  }
  return candidates[0].peer_id
}

export function rankEligibleLeaderPeers(peers, options = {}) {
  return peers
    .filter(peer => (options.peerId === undefined || peer.peer_id === options.peerId)
      && eligible(peer, options))
    .sort((left, right) => score(left) - score(right)
      || String(left.peer_id).localeCompare(String(right.peer_id)))
}

function eligible(peer, options) {
  try {
    assertEligible(peer, options)
    return true
  } catch {
    return false
  }
}

function assertEligible(peer, options) {
  const leader = peer?.advertisement?.capabilities?.leader
  if (!leader?.protocols?.includes(LEADER_PROTOCOL)) {
    throw new Error(`peer ${String(peer?.peer_id)} does not advertise ${LEADER_PROTOCOL}`)
  }
  if (options.workspaceAlias && !leader.workspace_aliases?.includes(options.workspaceAlias)) {
    throw new Error(`peer ${peer.peer_id} does not advertise workspace ${options.workspaceAlias}`)
  }
  if (options.role && !leader.roles?.includes(options.role)) {
    throw new Error(`peer ${peer.peer_id} does not advertise role ${options.role}`)
  }
}

function score(peer) {
  const capabilities = peer.advertisement.capabilities
  const routePenalty = peer.route === 'DirectPrivate' ? 0 : peer.route === 'DirectPublic' ? 1_000 : 5_000
  const load = Number(capabilities.load)
  const rtt = Number(peer.observed_rtt_ms)
  const price = Number(capabilities.busy_price_per_gib)
  const loadPenalty = (Number.isFinite(load) ? Math.max(0, load) : 1) * 10_000
  const rttPenalty = Number.isFinite(rtt) ? Math.max(0, rtt) : 250
  const pricePenalty = (Number.isFinite(price) ? Math.max(0, price) : 0) * 1_000
  return routePenalty + loadPenalty + rttPenalty + pricePenalty
}

function normalizeResult(payload) {
  const stopReason = KNOWN_STOP_REASONS.has(payload?.stop_reason) ? payload.stop_reason : 'error'
  const output = Array.isArray(payload?.output)
    ? payload.output.filter(block => block !== null && typeof block === 'object' && !Array.isArray(block))
    : typeof payload?.text === 'string'
      ? [{ type: 'text', text: payload.text }]
      : []
  const diagnostic = typeof payload?.diagnostic === 'string'
    ? payload.diagnostic.slice(0, 4096)
    : stopReason === 'error' && payload?.stop_reason !== 'error'
      ? 'remote Leader returned an unknown stop reason'
      : undefined
  return { output, ...(diagnostic ? { diagnostic } : {}), stopReason }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class MeshLeaderProvider {
  capabilities = {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  inheritsParentContext = false

  constructor(ctx, config) {
    this.ctx = ctx
    this.name = config.providerName ?? 'mesh-leader'
    this.config = {
      peerId: config.peerId,
      workspaceAlias: config.workspaceAlias ?? 'default',
      role: config.role,
      hopBudget: Math.max(0, Number(config.hopBudget ?? 1)),
      pollIntervalMs: Math.max(100, Number(config.pollIntervalMs ?? 500)),
      resultTimeoutMs: Math.max(1_000, Number(config.resultTimeoutMs ?? 3_600_000)),
      cancelGraceMs: Math.max(100, Number(config.cancelGraceMs ?? 5_000)),
    }
  }

  async start(request) {
    request.signal.throwIfAborted()
    this.ctx.meshLeaders.assertLeader(request.parent)
    const remainingHopBudget = this.ctx.meshLeaders.outboundHopBudget(request.parent, this.config.hopBudget)
    const peers = await this.ctx.mesh.call('peers', {}, { signal: request.signal })
    const peerId = selectLeaderPeer(peers, this.config)
    const payload = {
      protocol: LEADER_PROTOCOL,
      type: 'task_start',
      label: request.label,
      prompt: structuredClone(request.prompt),
      workspace_alias: this.config.workspaceAlias,
      hop_budget: remainingHopBudget,
      origin_session_id: String(request.parent.id),
    }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_TASK_BYTES) {
      throw new Error(`Mesh Leader task exceeds ${MAX_TASK_BYTES} bytes; publish large inputs and send object ids instead`)
    }
    const accepted = await this.ctx.mesh.call('send', {
      peer_id: peerId,
      kind: 'task',
      payload,
      ttl_seconds: Math.max(60, Math.ceil(this.config.resultTimeoutMs / 1000) + 300),
    }, { signal: request.signal })
    const taskId = String(accepted.id)
    let settled = false
    let cancelled = false
    let cancelRequest

    const requestCancel = () => {
      if (cancelRequest !== undefined) return cancelRequest
      cancelled = true
      cancelRequest = this.ctx.mesh.call('send', {
        peer_id: peerId,
        kind: 'task_cancel',
        correlation_id: taskId,
        payload: { protocol: LEADER_PROTOCOL, type: 'task_cancel' },
        ttl_seconds: 3600,
      }).catch(error => {
        this.ctx.logger.warn(`Mesh Leader task ${taskId} cancellation delivery failed: ${String(error)}`)
      })
      return cancelRequest
    }
    const onAbort = () => { void requestCancel() }
    request.signal.addEventListener('abort', onAbort, { once: true })

    const result = (async () => {
      const deadline = Date.now() + this.config.resultTimeoutMs
      try {
        while (!cancelled && Date.now() < deadline) {
          const items = await this.ctx.mesh.call('inbox.list', { kind: 'task_result', limit: 100 })
          const envelope = items.find(item => item.correlation_id === taskId && item.from_peer === peerId)
          if (envelope !== undefined) {
            await this.ctx.mesh.call('inbox.ack', { id: envelope.id })
            return normalizeResult(envelope.payload)
          }
          await delay(this.config.pollIntervalMs)
        }
        if (cancelled) {
          await requestCancel()
          return { output: [], stopReason: 'aborted' }
        }
        void requestCancel()
        return {
          output: [],
          diagnostic: `remote Leader task timed out after ${this.config.resultTimeoutMs} ms`,
          stopReason: 'error',
        }
      } catch (error) {
        if (cancelled || request.signal.aborted) return { output: [], stopReason: 'aborted' }
        return {
          output: [],
          diagnostic: `Mesh Leader transport failed: ${String(error).slice(0, 4000)}`,
          stopReason: 'error',
        }
      } finally {
        settled = true
        request.signal.removeEventListener('abort', onAbort)
      }
    })()

    return {
      id: `mesh-${taskId}`,
      localAgent: undefined,
      result,
      dispose: async () => {
        if (!settled) await requestCancel()
        await Promise.race([result.then(() => undefined), delay(this.config.cancelGraceMs)])
      },
    }
  }
}

export function apply(ctx, config = {}) {
  ctx.subagents.registerProvider(new MeshLeaderProvider(ctx, config))
}
