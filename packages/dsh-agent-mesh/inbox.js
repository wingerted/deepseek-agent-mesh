import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'agent-mesh-leader-inbox'
export const inject = ['mesh', 'meshLeaders']

export const Config = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().default(1000),
})

const PROTOCOL = 'dsh-leader/1'
const CHAT_PROTOCOL = 'mesh-chat/1'

export function apply(ctx, config) {
  if (!config.enabled) return
  const active = new Map()
  const chats = new Map()
  const seenChatSlots = new Set()
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

  const finishChat = async (envelopeId) => {
    const entry = chats.get(envelopeId)
    if (entry === undefined) return
    const text = truncateUtf8(
      contentText(entry.output).trim(),
      Number(entry.envelope.payload?.contract?.max_message_bytes ?? 8192),
    )
    if (text !== '' && text.toUpperCase() !== 'SKIP') {
      await ctx.mesh.call('send', {
        peer_id: entry.envelope.from_peer,
        kind: 'message',
        correlation_id: entry.envelope.id,
        payload: {
          protocol: CHAT_PROTOCOL,
          type: 'chat_reply',
          room_id: entry.envelope.payload?.room_id,
          turn: Number(entry.envelope.payload?.turn ?? 0),
          reply_to: entry.envelope.payload?.message_id,
          body: text,
        },
        ttl_seconds: 3600,
      })
    }
    await ctx.mesh.call('inbox.ack', { id: entry.envelope.id })
    chats.delete(envelopeId)
  }

  const onEvent = (session, event) => {
    const entry = [...active.values()].find(candidate => String(session.id) === String(candidate.leader.id))
    const chat = [...chats.values()].find(candidate => String(session.id) === String(candidate.leader.id))
    const current = entry ?? chat
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
        void finishChat(chat.envelope.id).catch(error => {
          ctx.logger.warn(`Mesh chat ${chat.envelope.id} delivery failed; prompt remains pending: ${String(error)}`)
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
        ...[...chats.values()].map(entry => String(entry.leader.id)),
      ])
      const leaders = ctx.meshLeaders.leaders()
        .filter(leader => leader.status === 'idle' && !busyLeaderIds.has(String(leader.id)))
      if (leaders.length === 0) return

      const chatPromptEnvelope = items.find(item => isChatPrompt(item) && !chats.has(item.id))
      if (chatPromptEnvelope !== undefined) {
        localPeerId ??= String((await ctx.mesh.call('status')).peer_id ?? '')
        const slot = chatSlot(chatPromptEnvelope)
        if (!validChatPrompt(chatPromptEnvelope, localPeerId) || seenChatSlots.has(slot)) {
          await ctx.mesh.call('inbox.ack', { id: chatPromptEnvelope.id })
          return
        }
        const leader = leaders[0]
        const userMessage = createUserMessage({
          content: [{ type: 'text', text: chatPrompt(chatPromptEnvelope) }],
          source: { kind: 'user' },
        })
        chats.set(chatPromptEnvelope.id, {
          envelope: chatPromptEnvelope,
          leader,
          messageId: userMessage.id,
          started: false,
          output: [],
        })
        seenChatSlots.add(slot)
        if (seenChatSlots.size > 1_024) seenChatSlots.delete(seenChatSlots.values().next().value)
        try {
          leader.followup(userMessage)
        } catch (error) {
          seenChatSlots.delete(slot)
          chats.delete(chatPromptEnvelope.id)
          throw error
        }
        return
      }

      const unsupportedChat = items.find(item => item.kind === 'message'
        && item.payload?.protocol === CHAT_PROTOCOL)
      if (unsupportedChat !== undefined) {
        await ctx.mesh.call('inbox.ack', { id: unsupportedChat.id })
        return
      }

      const message = items.find(item => item.kind === 'message'
        && item.payload?.protocol !== CHAT_PROTOCOL)
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
    chats.clear()
    disposeController()
  }, 'agentMesh.leaderInbox()')
}

export function isChatPrompt(envelope) {
  return envelope?.kind === 'message'
    && envelope?.payload?.protocol === CHAT_PROTOCOL
    && envelope?.payload?.type === 'chat_prompt'
}

export function chatPrompt(envelope) {
  const payload = envelope.payload ?? {}
  const contract = payload.contract ?? {}
  return [
    `[Mesh Leader chat ${String(contract.name ?? payload.room_id ?? 'unknown')}]`,
    contract.description ? `Room description: ${String(contract.description)}` : '',
    `The Watcher says: ${String(payload.text ?? '')}`,
    'Reply naturally as this node\'s Leader, based on what you actually know and can do. Be concise and do not impersonate another node.',
    `You have one external reply for turn ${String(payload.turn ?? 0)}, at most ${String(contract.max_message_bytes ?? 8192)} bytes. Return exactly SKIP if you have nothing useful to add.`,
    'You may reason with your local Agent Team, but do not send or trigger another Mesh message. The host will relay your final reply into the room.',
    payload.context ? `Recent room context:\n${truncateUtf8(String(payload.context), 16_384)}` : '',
  ].filter(Boolean).join('\n')
}

function validChatPrompt(envelope, localPeerId) {
  const payload = envelope?.payload ?? {}
  const contract = payload.contract ?? {}
  const participants = Array.isArray(contract.participants) ? contract.participants : []
  const turn = Number(payload.turn)
  const maxTurns = Number(contract.max_turns)
  const maxBytes = Number(contract.max_message_bytes)
  return localPeerId !== ''
    && participants.includes(localPeerId)
    && typeof payload.room_id === 'string'
    && payload.room_id.length <= 128
    && typeof payload.message_id === 'string'
    && payload.message_id.length <= 128
    && typeof payload.text === 'string'
    && Number.isSafeInteger(turn) && turn >= 1 && turn <= 1_000
    && Number.isSafeInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 1_000
    && Number.isSafeInteger(maxBytes) && maxBytes >= 256 && maxBytes <= 65_536
}

function chatSlot(envelope) {
  return [envelope.from_peer, envelope.payload?.room_id, envelope.payload?.turn].join(':')
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n\n')
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
