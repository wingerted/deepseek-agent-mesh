import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-mesh-leader-tools'
export const inject = ['tools', 'meshLeaders']

const objectOutput = { type: 'object', additionalProperties: true }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'mesh_leader_bind',
    description: 'Add the calling root Agent to this node\'s persistent Mesh Leader Sessions. Every bound Leader may delegate and receive its own inbound tasks.',
    parameters: {
      replace: { type: 'boolean', description: 'Replace all existing Leader Sessions with the caller instead of adding it.' },
    },
    output: { schema: objectOutput, render: renderJson },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('mesh_leader_bind requires a calling Agent')
      return ctx.meshLeaders.bind(exec.agent, args.replace === true)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_leader_status',
    description: 'List this node\'s bound Mesh Leader Sessions, their live states, and whether the caller is a Leader.',
    parameters: {},
    output: { schema: objectOutput, render: renderJson },
    execute: (_args, exec) => ctx.meshLeaders.view(exec.agent),
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_task_complete',
    description: 'Complete the currently assigned inbound Leader task after coordinating this node\'s local Agent Team.',
    parameters: {
      task_id: { type: 'string', required: true },
      result: { type: 'string', required: true },
    },
    output: { schema: objectOutput, render: renderJson },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('mesh_task_complete requires a calling Agent')
      return ctx.meshLeaders.complete(exec.agent, args.task_id, {
        output: [{ type: 'text', text: args.result }],
        stop_reason: 'completed',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_task_fail',
    description: 'Fail the currently assigned inbound Leader task with a safe diagnostic.',
    parameters: {
      task_id: { type: 'string', required: true },
      diagnostic: { type: 'string', required: true },
    },
    output: { schema: objectOutput, render: renderJson },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('mesh_task_fail requires a calling Agent')
      return ctx.meshLeaders.complete(exec.agent, args.task_id, {
        output: [],
        stop_reason: 'error',
        diagnostic: args.diagnostic.slice(0, 4096),
      })
    },
  }))
}
