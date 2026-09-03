import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'agent-mesh-leader-inbox'
export const inject = ['mesh', 'meshLeaders']

export const Config = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().default(1000),
})

const PROTOCOL = 'dsh-leader/1'

export function apply(ctx, config) {
  if (!config.enabled) return
  const active = new Map()
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

  const onEvent = (session, event) => {
    const entry = [...active.values()].find(candidate => String(session.id) === String(candidate.leader.id))
    if (entry === undefined || String(session.id) !== String(entry.leader.id)) return
    if (event.type === 'user/message' && String(event.data.id) === String(entry.messageId)) {
      entry.started = true
      return
    }
    if (!entry.started) return
    if (event.type === 'assistant/message' && event.data.message.content.length > 0) {
      entry.output = structuredClone(event.data.message.content)
      return
    }
    if (event.type === 'turn/end') {
      void finish(entry.envelope.id, {
        output: entry.output ?? [],
        stop_reason: turnStopReason(event.data.reason),
        ...(turnStopReason(event.data.reason) === 'completed'
          ? {}
          : { diagnostic: `remote Leader turn ended: ${reasonText(event.data.reason)}` }),
      }).catch(error => {
        ctx.logger.warn(`Mesh Leader task ${entry.envelope.id} result delivery failed; task remains pending: ${String(error)}`)
      })
    }
  }
  ctx.on('session/event', onEvent)

  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const items = await ctx.mesh.call('inbox.list', { limit: 100 })
      await handleCancellations(ctx, items, active, finish)
      const busyLeaderIds = new Set([...active.values()].map(entry => String(entry.leader.id)))
      const leaders = ctx.meshLeaders.leaders()
        .filter(leader => leader.status === 'idle' && !busyLeaderIds.has(String(leader.id)))
      if (leaders.length === 0) return

      const message = items.find(item => item.kind === 'message')
      if (message !== undefined) {
        const leader = leaders[0]
        leader.followup(createUserMessage({
          content: [{ type: 'text', text: `Mesh message from Leader ${message.from_peer}:\n\n${String(message.payload?.text ?? '')}` }],
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
    disposeController()
  }, 'agentMesh.leaderInbox()')
}

function taskContent(envelope) {
  const payload = envelope.payload ?? {}
  const blocks = Array.isArray(payload.prompt)
    ? payload.prompt.filter(block => block !== null && typeof block === 'object' && !Array.isArray(block))
    : [{ type: 'text', text: String(payload.prompt ?? '') }]
  const header = [
    `[Mesh Leader task ${envelope.id}]`,
    `Requested by Leader ${envelope.from_peer}.`,
    `Workspace alias: ${String(payload.workspace_alias ?? 'default')}.`,
    `Remaining cross-node hop budget: ${String(payload.hop_budget ?? 0)}.`,
    'You own this task as the sovereign Leader of this node. Coordinate your local Agent Team as needed.',
    `When the answer is ready, call mesh_task_complete with task_id ${envelope.id}. If you do not call it, the final assistant response for this turn is returned automatically.`,
  ].join('\n')
  return [{ type: 'text', text: header }, ...blocks]
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
