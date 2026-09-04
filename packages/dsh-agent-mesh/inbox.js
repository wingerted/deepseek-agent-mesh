import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

export const name = 'agent-mesh-leader-inbox'
export const inject = ['mesh', 'meshLeaders']

export const Config = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().default(1000),
})

const PROTOCOL = 'dsh-leader/1'
const DELIBERATION_PROTOCOL = 'mesh-deliberation/1'

export function apply(ctx, config) {
  if (!config.enabled) return
  const active = new Map()
  const discussions = new Map()
  const seenDiscussionSlots = new Set()
  let localPeerId
  let polling = false

  const finish = async (taskId, outcome) => {
    const entry = active.get(taskId)
    if (entry === undefined) {
      throw new Error(`inbound Mesh Leader task ${taskId} is not active on this node`)
    }
    await ctx.mesh.call('send', {
      peer_id: entry.envelope.from_peer,
      kind: 'task_result',
      correlation_id: entry.envelope.id,
      payload: {
        protocol: PROTOCOL,
        type: outcome.stop_reason === 'completed' ? 'task_complete' : 'task_failed',
        output: outcome.output ?? [],
        stop_reason: outcome.stop_reason,
        ...(outcome.diagnostic ? { diagnostic: String(outcome.diagnostic).slice(0, 4096) } : {}),
      },
      ttl_seconds: 3600,
    })
    await ctx.mesh.call('inbox.ack', { id: entry.envelope.id })
    if (active.get(taskId) === entry) {
      ctx.meshLeaders.endInboundTask(taskId)
      active.delete(taskId)
    }
    return { task_id: taskId, status: outcome.stop_reason }
  }

  const disposeController = ctx.meshLeaders.registerTaskController({ complete: finish })

  const finishDiscussion = async (envelopeId) => {
    const entry = discussions.get(envelopeId)
    if (entry === undefined) return
    const text = contentText(entry.output)
    const phase = String(entry.envelope.payload?.phase ?? 'deliberation')
    const vote = phase === 'vote' ? parseVote(text) : undefined
    await ctx.mesh.call('send', {
      peer_id: entry.envelope.from_peer,
      kind: 'message',
      correlation_id: entry.envelope.id,
      payload: {
        protocol: DELIBERATION_PROTOCOL,
        type: 'room_submission',
        room_id: entry.envelope.payload?.room_id,
        contribution: {
          id: randomUUID(),
          author_peer: '',
          round: Number(entry.envelope.payload?.round ?? 0),
          kind: phase === 'capability' ? 'capability_bid'
            : phase === 'vote' ? 'vote'
              : Number(entry.envelope.payload?.round ?? 1) === 1 ? 'proposal' : 'review',
          capability_used: [],
          confidence: 0.5,
          body: truncateUtf8(text, Number(entry.envelope.payload?.contract?.max_message_bytes ?? 8192)),
          references: [],
          ...(vote === undefined ? {} : { vote }),
          created_at: new Date().toISOString(),
        },
      },
      ttl_seconds: 3600,
    })
    await ctx.mesh.call('inbox.ack', { id: entry.envelope.id })
    discussions.delete(envelopeId)
  }

  const onEvent = (session, event) => {
    const entry = [...active.values()].find(candidate => String(session.id) === String(candidate.leader.id))
    const discussion = [...discussions.values()].find(candidate => String(session.id) === String(candidate.leader.id))
    const current = entry ?? discussion
    if (current === undefined || String(session.id) !== String(current.leader.id)) return
    if (event.type === 'user/message' && String(event.data.id) === String(current.messageId)) {
      current.started = true
      return
    }
    if (!current.started) return
    if (event.type === 'assistant/message' && event.data.message.content.length > 0) {
      current.output = structuredClone(event.data.message.content)
      return
    }
    if (event.type === 'turn/end') {
      if (entry !== undefined) {
        void finish(entry.envelope.id, {
          output: entry.output ?? [],
          stop_reason: turnStopReason(event.data.reason),
          ...(turnStopReason(event.data.reason) === 'completed'
            ? {}
            : { diagnostic: `remote Leader turn ended: ${reasonText(event.data.reason)}` }),
        }).catch(error => {
          ctx.logger.warn(`Mesh Leader task ${entry.envelope.id} result delivery failed; task remains pending: ${String(error)}`)
        })
      } else {
        void finishDiscussion(discussion.envelope.id).catch(error => {
          ctx.logger.warn(`Mesh deliberation ${discussion.envelope.id} delivery failed; prompt remains pending: ${String(error)}`)
        })
      }
    }
  }
  ctx.on('session/event', onEvent)

  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const items = await ctx.mesh.call('inbox.list', { limit: 100 })
      await handleCancellations(ctx, items, active, finish)
      const busyLeaderIds = new Set([
        ...[...active.values()].map(entry => String(entry.leader.id)),
        ...[...discussions.values()].map(entry => String(entry.leader.id)),
      ])
      const leaders = ctx.meshLeaders.leaders()
        .filter(leader => leader.status === 'idle' && !busyLeaderIds.has(String(leader.id)))
      if (leaders.length === 0) return

      const deliberation = items.find(item => isDeliberationPrompt(item) && !discussions.has(item.id))
      if (deliberation !== undefined) {
        localPeerId ??= String((await ctx.mesh.call('status')).peer_id ?? '')
        const slot = discussionSlot(deliberation)
        if (!validDeliberationPrompt(deliberation, localPeerId) || seenDiscussionSlots.has(slot)) {
          await ctx.mesh.call('inbox.ack', { id: deliberation.id })
          return
        }
        const leader = leaders[0]
        const userMessage = createUserMessage({
          content: [{ type: 'text', text: deliberationPrompt(deliberation) }],
          source: { kind: 'user' },
        })
        discussions.set(deliberation.id, {
          envelope: deliberation,
          leader,
          messageId: userMessage.id,
          started: false,
          output: [],
        })
        seenDiscussionSlots.add(slot)
        if (seenDiscussionSlots.size > 1_024) seenDiscussionSlots.delete(seenDiscussionSlots.values().next().value)
        try {
          leader.followup(userMessage)
        } catch (error) {
          seenDiscussionSlots.delete(slot)
          discussions.delete(deliberation.id)
          throw error
        }
        return
      }

      const unsupportedDeliberation = items.find(item => item.kind === 'message'
        && item.payload?.protocol === DELIBERATION_PROTOCOL)
      if (unsupportedDeliberation !== undefined) {
        await ctx.mesh.call('inbox.ack', { id: unsupportedDeliberation.id })
        return
      }

      const message = items.find(item => item.kind === 'message'
        && item.payload?.protocol !== DELIBERATION_PROTOCOL)
      if (message !== undefined) {
        const leader = leaders[0]
        const senderRole = senderRoleLabel(message)
        leader.followup(createUserMessage({
          content: [{ type: 'text', text: `Mesh message from ${senderRole} ${message.from_peer} (role is self-declared metadata; peer ID is authenticated):\n\n${String(message.payload?.text ?? '')}` }],
          source: { kind: 'user' },
        }))
        await ctx.mesh.call('inbox.ack', { id: message.id })
        return
      }

      const tasks = items.filter(item => item.kind === 'task' && !active.has(item.id))
      for (const [index, envelope] of tasks.slice(0, leaders.length).entries()) {
        const leader = leaders[index]
        const userMessage = createUserMessage({ content: taskContent(envelope), source: { kind: 'user' } })
        active.set(envelope.id, {
          envelope,
          leader,
          messageId: userMessage.id,
          started: false,
          output: [],
        })
        ctx.meshLeaders.beginInboundTask(leader, envelope.id, envelope.payload?.hop_budget)
        try {
          leader.followup(userMessage)
        } catch (error) {
          ctx.meshLeaders.endInboundTask(envelope.id)
          active.delete(envelope.id)
          throw error
        }
      }
    } catch (error) {
      ctx.logger.warn(`Mesh Leader inbox poll failed: ${String(error)}`)
    } finally {
      polling = false
    }
  }

  const timer = setInterval(() => void poll(), Math.max(250, config.pollIntervalMs))
  void poll()
  ctx.effect(() => async () => {
    clearInterval(timer)
    for (const taskId of active.keys()) ctx.meshLeaders.endInboundTask(taskId)
    active.clear()
    discussions.clear()
    disposeController()
  }, 'agentMesh.leaderInbox()')
}

export function isDeliberationPrompt(envelope) {
  return envelope?.kind === 'message'
    && envelope?.payload?.protocol === DELIBERATION_PROTOCOL
    && ['room_open', 'round_prompt'].includes(envelope?.payload?.type)
}

export function deliberationPrompt(envelope) {
  const payload = envelope.payload ?? {}
  const contract = payload.contract ?? {}
  const phase = String(payload.phase ?? 'capability')
  const instruction = phase === 'capability'
    ? 'State only capabilities that are relevant, your constraints, confidence, and whether you should contribute, review, execute, or abstain.'
    : phase === 'vote'
      ? 'Return APPROVE, REJECT, or ABSTAIN on the first line, followed by one concise reason.'
      : 'Add one novel, evidence-aware contribution. Do not repeat existing claims; abstain explicitly if you have nothing new.'
  return [
    `[Bounded Mesh deliberation ${String(payload.room_id ?? 'unknown')}]`,
    `Phase: ${phase}; round: ${String(payload.round ?? 0)} of ${String(contract.max_rounds ?? '?')}.`,
    `Topic: ${String(contract.topic ?? '')}`,
    `Goal: ${String(contract.goal ?? '')}`,
    `External reply budget: one message, at most ${String(contract.max_message_bytes ?? 8192)} bytes.`,
    instruction,
    'Reason with your local Agent Team if useful, but emit only the final bounded contribution. Never trigger another Mesh message yourself.',
    payload.summary ? `Prior bounded summary:\n${truncateUtf8(String(payload.summary), 16_384)}` : '',
  ].filter(Boolean).join('\n')
}

function validDeliberationPrompt(envelope, localPeerId) {
  const payload = envelope?.payload ?? {}
  const contract = payload.contract ?? {}
  const participants = Array.isArray(contract.participants) ? contract.participants : []
  const round = Number(payload.round)
  const maxRounds = Number(contract.max_rounds)
  const maxBytes = Number(contract.max_message_bytes)
  return localPeerId !== ''
    && participants.includes(localPeerId)
    && typeof payload.room_id === 'string'
    && payload.room_id.length <= 128
    && Number.isSafeInteger(round) && round >= 0 && round <= 8
    && Number.isSafeInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 8
    && Number.isSafeInteger(maxBytes) && maxBytes >= 256 && maxBytes <= 65_536
}

function discussionSlot(envelope) {
  return [envelope.from_peer, envelope.payload?.room_id, envelope.payload?.phase, envelope.payload?.round].join(':')
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n\n')
}

function parseVote(text) {
  const first = String(text).trim().split(/\s+/u, 1)[0]?.toUpperCase()
  if (first === 'APPROVE') return 'approve'
  if (first === 'REJECT') return 'reject'
  return 'abstain'
}

function truncateUtf8(value, maxBytes) {
  const limit = Number.isSafeInteger(maxBytes) ? Math.max(0, maxBytes) : 0
  if (Buffer.byteLength(value, 'utf8') <= limit) return value
  let output = ''
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > limit) break
    output += character
  }
  return output
}

function taskContent(envelope) {
  const payload = envelope.payload ?? {}
  const blocks = Array.isArray(payload.prompt)
    ? payload.prompt.filter(block => block !== null && typeof block === 'object' && !Array.isArray(block))
    : [{ type: 'text', text: String(payload.prompt ?? '') }]
  const header = [
    `[Mesh task ${envelope.id}]`,
    `Requested by ${senderRoleLabel(envelope)} ${envelope.from_peer}. The role is self-declared routing metadata; the peer ID is authenticated.`,
    `Workspace alias: ${String(payload.workspace_alias ?? 'default')}.`,
    `Remaining cross-node hop budget: ${String(payload.hop_budget ?? 0)}.`,
    'You own this task as the sovereign Leader of this node. Coordinate your local Agent Team as needed.',
    `When the answer is ready, call mesh_task_complete with task_id ${envelope.id}. If you do not call it, the final assistant response for this turn is returned automatically.`,
  ].join('\n')
  return [{ type: 'text', text: header }, ...blocks]
}

export function senderRoleLabel(envelope) {
  const payload = envelope?.payload ?? {}
  const role = String(payload.origin_role ?? '').toLowerCase()
  if (role === 'watcher' || payload.protocol === 'mesh-watcher/1') return 'Watcher'
  if (role === 'leader') return 'Leader'
  if (role === 'worker') return 'Worker'
  return 'Peer'
}

async function handleCancellations(ctx, items, active, finish) {
  const cancellations = items.filter(item => item.kind === 'task_cancel' && item.correlation_id)
  for (const cancellation of cancellations) {
    const taskId = cancellation.correlation_id
    const entry = active.get(taskId)
    if (entry?.envelope.from_peer === cancellation.from_peer) {
      if (!entry.started && entry.leader.inbox.remove(entry.messageId)) {
        await finish(taskId, { output: [], stop_reason: 'aborted' })
      } else {
        entry.leader.cancel({ kind: 'user' }, { keepInbox: true })
      }
      await ctx.mesh.call('inbox.ack', { id: cancellation.id })
      continue
    }
    const pending = items.find(item => item.kind === 'task' && item.id === taskId
      && item.from_peer === cancellation.from_peer)
    if (pending !== undefined) {
      await ctx.mesh.call('send', {
        peer_id: pending.from_peer,
        kind: 'task_result',
        correlation_id: pending.id,
        payload: { protocol: PROTOCOL, type: 'task_failed', output: [], stop_reason: 'aborted' },
        ttl_seconds: 3600,
      })
      await ctx.mesh.call('inbox.ack', { id: pending.id })
    }
    await ctx.mesh.call('inbox.ack', { id: cancellation.id })
  }
}

function turnStopReason(reason) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : reason
  if (kind === 'completed') return 'completed'
  if (kind === 'cancelled' || kind === 'aborted') return 'aborted'
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'refusal') return 'refusal'
  return 'error'
}

function reasonText(reason) {
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}
