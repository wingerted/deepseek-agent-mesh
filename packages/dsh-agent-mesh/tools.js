import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-mesh-tools'
export const inject = ['tools', 'mesh', 'meshLeaders']

const openObject = { type: 'object', additionalProperties: true }
const openArray = { type: 'array', items: openObject }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'mesh_peers',
    description: 'List fresh DeepSeek Harness peers, declared resources, routes, inventories, and measured RTT.',
    parameters: {},
    output: { schema: openArray, render: renderJson },
    execute: (_args, exec) => {
      assertLeader(ctx, exec)
      return ctx.mesh.call('peers', {}, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_send',
    description: 'Send a durable one-way message to an allowlisted Harness peer.',
    parameters: {
      peer_id: { type: 'string', required: true },
      text: { type: 'string', required: true },
      ttl_seconds: { type: 'number' },
    },
    output: { schema: openObject, render: renderJson },
    execute: (args, exec) => {
      assertLeader(ctx, exec)
      return ctx.mesh.call('send', {
        peer_id: args.peer_id,
        kind: 'message',
        payload: { text: args.text },
        ttl_seconds: args.ttl_seconds ?? 3600,
      }, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_task',
    description: 'Ask an allowlisted remote Harness node to execute a prompt. Optionally wait for its correlated result.',
    parameters: {
      peer_id: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      wait_seconds: { type: 'number' },
    },
    output: { schema: openObject, render: renderJson },
    async execute(args, exec) {
      assertLeader(ctx, exec)
      const accepted = await ctx.mesh.call('send', {
        peer_id: args.peer_id,
        kind: 'task',
        payload: { prompt: args.prompt },
        ttl_seconds: Math.max(60, (args.wait_seconds ?? 0) + 300),
      }, { signal: exec.signal })
      if (!(args.wait_seconds > 0)) return { task_id: accepted.id, status: 'accepted' }
      const deadline = Date.now() + args.wait_seconds * 1000
      while (Date.now() < deadline) {
        exec.signal.throwIfAborted()
        const items = await ctx.mesh.call('inbox.list', { kind: 'task_result', limit: 100 }, { signal: exec.signal })
        const result = items.find(item => item.correlation_id === accepted.id)
        if (result !== undefined) {
          await ctx.mesh.call('inbox.ack', { id: result.id }, { signal: exec.signal })
          return { task_id: accepted.id, status: 'completed', result: result.payload, from_peer: result.from_peer }
        }
        await abortableDelay(500, exec.signal)
      }
      return { task_id: accepted.id, status: 'accepted' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_transfer',
    description: 'Publish a local file to the content-addressed mesh, or fetch an object using cost-aware route selection.',
    parameters: {
      action: { type: 'string', required: true, enum: ['publish', 'fetch'] },
      path: { type: 'string', required: true },
      object_id: { type: 'string' },
      max_cost: { type: 'number' },
      optimize: { type: 'string', enum: ['cost', 'speed', 'balanced'] },
      request_source_delete: { type: 'boolean' },
    },
    output: { schema: openObject, render: renderJson },
    execute(args, exec) {
      assertLeader(ctx, exec)
      if (args.action === 'publish') return ctx.mesh.call('publish', { path: args.path }, { signal: exec.signal })
      if (!args.object_id) throw new Error('object_id is required for fetch')
      return ctx.mesh.call('fetch', {
        object_id: args.object_id,
        output: args.path,
        max_cost: args.max_cost ?? 1_000_000_000,
        optimize: args.optimize ?? 'balanced',
        request_source_delete: args.request_source_delete ?? false,
      }, { signal: exec.signal, timeoutMs: 24 * 60 * 60 * 1000 })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_inbox',
    description: 'Read durable incoming mesh messages, tasks, and task results. Items stay pending until acknowledged.',
    parameters: {
      kind: { type: 'string', enum: ['message', 'task', 'task_cancel', 'task_progress', 'task_result'] },
      limit: { type: 'number' },
    },
    output: { schema: openArray, render: renderJson },
    execute: (args, exec) => {
      assertLeader(ctx, exec)
      return ctx.mesh.call('inbox.list', { kind: args.kind, limit: args.limit ?? 100 }, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_reply',
    description: 'Send a result correlated to a received mesh task, then acknowledge that task locally.',
    parameters: {
      peer_id: { type: 'string', required: true },
      task_id: { type: 'string', required: true },
      result: { type: 'string', required: true },
      inbox_id: { type: 'string', required: true },
    },
    output: { schema: openObject, render: renderJson },
    async execute(args, exec) {
      assertLeader(ctx, exec)
      const sent = await ctx.mesh.call('send', {
        peer_id: args.peer_id,
        kind: 'task_result',
        correlation_id: args.task_id,
        payload: { text: args.result },
        ttl_seconds: 3600,
      }, { signal: exec.signal })
      await ctx.mesh.call('inbox.ack', { id: args.inbox_id }, { signal: exec.signal })
      return sent
    },
  }))
}

function assertLeader(ctx, exec) {
  if (!exec.agent) throw new Error('Mesh tools require a calling Agent')
  ctx.meshLeaders.assertLeader(exec.agent)
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}
