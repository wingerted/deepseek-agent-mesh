import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-mesh-leader-tools'
export const inject = ['tools', 'meshLeaders']

const objectOutput = { type: 'object', additionalProperties: true }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'mesh_leader_bind',
    description: 'Bind the calling root Agent as this node\'s persistent Mesh Leader. Only the bound Leader may delegate to other nodes or complete inbound tasks.',
    parameters: {
      replace: { type: 'boolean', description: 'Replace a different existing Leader binding.' },
    },
    output: { schema: objectOutput, render: renderJson },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('mesh_leader_bind requires a calling Agent')
      return ctx.meshLeaders.bind(exec.agent, args.replace === true)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_leader_status',
    description: 'Show which Harness Session is bound as this node\'s Mesh Leader and whether it is live.',
    parameters: {},
    output: { schema: objectOutput, render: renderJson },
    execute: () => ctx.meshLeaders.view(),
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
