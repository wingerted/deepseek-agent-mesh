import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'

export const name = 'agent-mesh-leader'
export const inject = ['agents', 'mesh', 'typert']

const STATE_VERSION = 2

export class MeshLeaderRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'meshLeaders')
    this.runtimeCtx = ctx
    this.leaderSessionIds = new Set()
    this.bindingQueue = Promise.resolve()
    this.taskController = undefined
    this.inboundTasks = new Map()
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.statePath(), 'utf8'))
      if (state.version === STATE_VERSION && Array.isArray(state.leader_session_ids)) {
        this.leaderSessionIds = new Set(state.leader_session_ids.filter(value => typeof value === 'string' && value !== ''))
      } else if (state.version === 1 && typeof state.leader_session_id === 'string') {
        this.leaderSessionIds.add(state.leader_session_id)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  leaders() {
    return [...this.leaderSessionIds]
      .map(sessionId => this.runtimeCtx.agents.get(sessionId))
      .filter(agent => agent !== undefined)
  }

  async wakeBoundLeaders() {
    const lookup = this.runtimeCtx.typert.lookups.get('agent')
    if (lookup === undefined) {
      this.runtimeCtx.logger.warn('Mesh Leader Sessions cannot be resumed: the Harness agent lookup is unavailable')
      return
    }
    for (const sessionId of this.leaderSessionIds) {
      if (this.runtimeCtx.agents.get(sessionId) !== undefined) continue
      try {
        await lookup.resolve(sessionId)
      } catch (error) {
        this.runtimeCtx.logger.warn(`Mesh Leader Session ${sessionId} could not be resumed: ${String(error)}`)
      }
    }
  }

  isLeader(agent) {
    return agent !== undefined && this.leaderSessionIds.has(String(agent.id))
  }

  view(agent) {
    const leaders = [...this.leaderSessionIds].map(sessionId => {
      const live = this.runtimeCtx.agents.get(sessionId)
      return {
        session_id: sessionId,
        live: live !== undefined,
        status: live?.status ?? null,
      }
    })
    return {
      bound: leaders.length > 0,
      leader_session_ids: leaders.map(leader => leader.session_id),
      live_count: leaders.filter(leader => leader.live).length,
      leaders,
      current_session_id: agent === undefined ? null : String(agent.id),
      current_session_is_leader: agent === undefined ? null : this.isLeader(agent),
    }
  }

  bind(agent, replace = false) {
    if (agent.session.header.parentSession !== undefined) {
      throw new Error('only a root Harness Agent can become the Mesh Leader')
    }
    const queued = this.bindingQueue.then(async () => {
      const sessionId = String(agent.id)
      if (replace) this.leaderSessionIds.clear()
      this.leaderSessionIds.add(sessionId)
      await mkdir(this.ctx.mesh.stateDir, { recursive: true })
      const target = this.statePath()
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({
        version: STATE_VERSION,
        leader_session_ids: [...this.leaderSessionIds],
      }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, target)
      return this.view(agent)
    })
    this.bindingQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  assertLeader(agent) {
    if (!this.isLeader(agent)) {
      const suffix = this.leaderSessionIds.size === 0
        ? 'no Mesh Leader Session is bound; call mesh_leader_bind first'
        : `this node's Mesh Leader Sessions are ${[...this.leaderSessionIds].join(', ')}`
      throw new Error(`Leader-only Mesh operation rejected: ${suffix}`)
    }
    return agent
  }

  beginInboundTask(agent, taskId, hopBudget) {
    this.assertLeader(agent)
    const sessionId = String(agent.id)
    const existing = [...this.inboundTasks.values()].find(task => task.leaderSessionId === sessionId)
    if (existing !== undefined && existing.taskId !== taskId) {
      throw new Error(`Mesh Leader Session ${sessionId} is already processing inbound task ${existing.taskId}`)
    }
    this.inboundTasks.set(taskId, {
      taskId,
      leaderSessionId: sessionId,
      hopBudget: Math.max(0, Number.isSafeInteger(hopBudget) ? hopBudget : 0),
    })
  }

  endInboundTask(taskId) {
    this.inboundTasks.delete(taskId)
  }

  outboundHopBudget(agent, configuredBudget) {
    this.assertLeader(agent)
    const sessionId = String(agent.id)
    const inboundTask = [...this.inboundTasks.values()].find(task => task.leaderSessionId === sessionId)
    const available = inboundTask?.hopBudget ?? Math.max(0, Math.trunc(configuredBudget))
    if (available <= 0) {
      throw new Error('cross-node delegation budget is exhausted; use this node\'s local Agent Team instead')
    }
    return available - 1
  }

  registerTaskController(controller) {
    if (this.taskController !== undefined) throw new Error('a Mesh Leader task controller is already registered')
    this.taskController = controller
    return () => {
      if (this.taskController === controller) this.taskController = undefined
    }
  }

  complete(agent, taskId, outcome) {
    this.assertLeader(agent)
    const task = this.inboundTasks.get(taskId)
    if (task === undefined || task.leaderSessionId !== String(agent.id)) {
      throw new Error(`inbound Mesh Leader task ${taskId} is not assigned to this Leader Session`)
    }
    if (this.taskController === undefined) throw new Error('Mesh Leader inbox is unavailable')
    return this.taskController.complete(taskId, outcome)
  }

  statePath() {
    return join(this.ctx.mesh.stateDir, 'leader.json')
  }
}

export async function apply(ctx) {
  const runtime = new MeshLeaderRuntime(ctx)
  await runtime.load()
  await runtime.wakeBoundLeaders()
  void runtime
}
