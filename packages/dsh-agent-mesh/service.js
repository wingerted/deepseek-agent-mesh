import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { meshCall } from './lib/rpc.js'

export const name = 'agent-mesh-service'
export const inject = ['subprocess']

export const Config = z.object({
  mode: z.union(['managed', 'external']).default('managed'),
  binary: z.string().default('agent-mesh'),
  stateDir: z.string().required(),
  networkId: z.string().default('default'),
  nodeName: z.string().default('deepseek-harness'),
  listen: z.array(z.string()).default([]),
  bootstrap: z.array(z.string()).default([]),
  allowPeers: z.array(z.string()).default([]),
  allowAllPeers: z.boolean().default(false),
  privateNetworks: z.array(z.string()).default([]),
  region: z.string().default('local'),
  zone: z.string().default('default'),
  ingressMbps: z.number().default(1000),
  egressMbps: z.number().default(100),
  idlePricePerGib: z.number().default(0),
  busyPricePerGib: z.number().default(0),
  leaderProtocols: z.array(z.string()).default(['dsh-leader/1']),
  leaderRoles: z.array(z.string()).default(['general']),
  leaderWorkspaces: z.array(z.string()).default(['default']),
  leaderTeamEnabled: z.boolean().default(true),
  leaderMaxParallelTasks: z.number().default(1),
  allowSourceDelete: z.boolean().default(false),
  startupTimeoutMs: z.number().default(15_000),
})

export class MeshRuntime extends Service {
  constructor(ctx, stateDir, processHandle, config) {
    super(ctx, 'mesh')
    this.stateDir = stateDir
    this.processHandle = processHandle
    this.config = config
  }

  call(method, params = {}, options = {}) {
    return meshCall(this.stateDir, method, params, options)
  }

  view() {
    return {
      mode: this.config.mode,
      state_dir: this.stateDir,
      network_id: this.config.networkId,
      node_name: this.config.nodeName,
      configured_listen_addresses: [...this.config.listen],
      bootstrap_addresses: [...this.config.bootstrap],
      allow_peers: [...this.config.allowPeers],
      allow_all_peers: this.config.allowAllPeers,
      private_networks: [...this.config.privateNetworks],
      region: this.config.region,
      zone: this.config.zone,
      ingress_mbps: this.config.ingressMbps,
      egress_mbps: this.config.egressMbps,
      idle_price_per_gib: this.config.idlePricePerGib,
      busy_price_per_gib: this.config.busyPricePerGib,
      leader_protocols: [...this.config.leaderProtocols],
      leader_roles: [...this.config.leaderRoles],
      leader_workspaces: [...this.config.leaderWorkspaces],
      leader_team_enabled: this.config.leaderTeamEnabled,
      leader_max_parallel_tasks: this.config.leaderMaxParallelTasks,
      allow_source_delete: this.config.allowSourceDelete,
    }
  }
}

export async function apply(ctx, config) {
  const stateDir = resolve(config.stateDir)
  await mkdir(stateDir, { recursive: true })
  let handle
  if (config.mode === 'managed') {
    const binary = await ctx.subprocess.resolveExecutable(config.binary)
    const args = [
      '--state-dir', stateDir,
      '--identity', resolve(stateDir, 'identity.key'),
      '--store', resolve(stateDir, 'store'),
      '--name', config.nodeName,
      '--network-id', config.networkId,
      '--region', config.region,
      '--zone', config.zone,
      '--ingress-mbps', String(config.ingressMbps),
      '--egress-mbps', String(config.egressMbps),
      '--idle-price-per-gib', String(config.idlePricePerGib),
      '--busy-price-per-gib', String(config.busyPricePerGib),
    ]
    for (const value of config.listen) args.push('--listen', value)
    for (const value of config.bootstrap) args.push('--bootstrap', value)
    for (const value of config.allowPeers) args.push('--allow-peer', value)
    for (const value of config.privateNetworks) args.push('--private-network', value)
    for (const value of config.leaderProtocols) args.push('--leader-protocol', value)
    for (const value of config.leaderRoles) args.push('--leader-role', value)
    for (const value of config.leaderWorkspaces) args.push('--leader-workspace', value)
    if (config.leaderTeamEnabled) args.push('--leader-team-enabled')
    args.push('--leader-max-parallel-tasks', String(config.leaderMaxParallelTasks))
    if (config.allowAllPeers) args.push('--allow-all-peers')
    args.push('daemon')
    if (config.allowSourceDelete) args.push('--allow-source-delete')
    handle = ctx.subprocess.spawn({
      argv: [binary, ...args],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      graceMs: 2_000,
      env: {},
    })
  }

  await waitUntilReady(stateDir, config.startupTimeoutMs, handle)
  const runtime = new MeshRuntime(ctx, stateDir, handle, config)
  ctx.effect(() => async () => {
    if (handle === undefined) return
    handle.terminate()
    await handle.waitForExit(AbortSignal.timeout(5_000))
  }, 'agentMesh.managedDaemon()')
  void runtime
}

async function waitUntilReady(stateDir, timeoutMs, handle) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      await meshCall(stateDir, 'status', {}, { timeoutMs: 500 })
      return
    } catch (error) {
      lastError = error
    }
    if (handle !== undefined) {
      const outcome = await Promise.race([handle.done, new Promise(resolve => setTimeout(() => resolve(null), 100))])
      if (outcome !== null) throw new Error(`agent-mesh daemon exited during startup: ${JSON.stringify(outcome)}`)
    } else {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`agent-mesh daemon did not become ready: ${String(lastError)}`)
}
