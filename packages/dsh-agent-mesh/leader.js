import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'

export const name = 'agent-mesh-leader'
export const inject = ['agents', 'mesh']

const STATE_VERSION = 1

export class MeshLeaderRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'meshLeaders')
    this.runtimeCtx = ctx
    this.leaderSessionId = undefined
    this.taskController = undefined
    this.inboundTask = undefined
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.statePath(), 'utf8'))
      if (state.version === STATE_VERSION && typeof state.leader_session_id === 'string') {
        this.leaderSessionId = state.leader_session_id
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  leader() {
    if (this.leaderSessionId === undefined) return undefined
    return this.runtimeCtx.agents.get(this.leaderSessionId)
  }

  view() {
    const leader = this.leader()
    return {
      bound: this.leaderSessionId !== undefined,
      leader_session_id: this.leaderSessionId,
      live: leader !== undefined,
      status: leader?.status,
    }
  }

  async bind(agent, replace = false) {
    if (agent.session.header.parentSession !== undefined) {
      throw new Error('only a root Harness Agent can become the Mesh Leader')
    }
    if (this.leaderSessionId !== undefined && this.leaderSessionId !== String(agent.id) && !replace) {
      throw new Error(`Mesh Leader is already bound to Session ${this.leaderSessionId}; set replace=true to replace it`)
    }
    await mkdir(this.ctx.mesh.stateDir, { recursive: true })
    const target = this.statePath()
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({
      version: STATE_VERSION,
      leader_session_id: String(agent.id),
    }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
    this.leaderSessionId = String(agent.id)
    return this.view()
  }

  assertLeader(agent) {
    const live = this.leader()
    if (live === undefined || live !== agent) {
      const suffix = this.leaderSessionId === undefined
        ? 'no Mesh Leader is bound; call mesh_leader_bind first'
        : `this node's Mesh Leader is Session ${this.leaderSessionId}`
      throw new Error(`Leader-only Mesh operation rejected: ${suffix}`)
    }
    return live
  }

  beginInboundTask(agent, taskId, hopBudget) {
    this.assertLeader(agent)
    if (this.inboundTask !== undefined && this.inboundTask.taskId !== taskId) {
      throw new Error(`Mesh Leader is already processing inbound task ${this.inboundTask.taskId}`)
    }
    this.inboundTask = {
      taskId,
      hopBudget: Math.max(0, Number.isSafeInteger(hopBudget) ? hopBudget : 0),
    }
  }

  endInboundTask(taskId) {
    if (this.inboundTask?.taskId === taskId) this.inboundTask = undefined
  }

  outboundHopBudget(agent, configuredBudget) {
    this.assertLeader(agent)
    const available = this.inboundTask?.hopBudget ?? Math.max(0, Math.trunc(configuredBudget))
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
  void runtime
}
