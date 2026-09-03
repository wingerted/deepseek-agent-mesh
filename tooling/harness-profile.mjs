import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRepo = resolve(process.env.DSH_REPO || join(root, '..', 'deepseek-harness'))
const action = process.argv[2] || 'web'
const configPath = resolveConfigPath()
const config = configPath === undefined ? {} : parse(readFileSync(configPath, 'utf8'))
const profile = process.env.AGENT_MESH_DSH_PROFILE || config.harness?.profile || 'web'
const dshHome = resolve(process.env.DSH_HOME || join(root, '.pixi', 'dsh-home'))
const env = buildEnvironment(config)

assertHarnessCheckout()

if (action === 'install') {
  buildWorkspace()
  installPlugins()
} else if (action === 'dump') {
  buildWorkspace()
  installPlugins()
  runDsh(['--profile', profile, '--dump-config'])
} else if (action === 'web') {
  buildWorkspace()
  installPlugins()
  const host = process.env.AGENT_MESH_WEB_HOST || config.harness?.host || '127.0.0.1'
  const port = String(process.env.AGENT_MESH_WEB_PORT || config.harness?.port || 8787)
  await runDshWeb(['--profile', profile, '--host', host, '--port', port, '--no-open'])
} else {
  throw new Error(`unknown action ${action}; expected install, dump, or web`)
}

function resolveConfigPath() {
  const flag = process.argv.indexOf('--config')
  const value = flag >= 0 ? process.argv[flag + 1] : process.env.AGENT_MESH_CONFIG
  if (value !== undefined) return resolve(value)
  const local = join(root, 'configs', 'local.toml')
  return existsSync(local) ? local : undefined
}

function buildEnvironment(value) {
  const mesh = value.mesh || {}
  const capacity = value.capacity || {}
  const output = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED || '1',
    AGENT_MESH_BIN: process.env.AGENT_MESH_BIN || join(root, 'target', 'release', 'agent-mesh'),
  }
  set(output, 'AGENT_MESH_STATE_DIR', mesh.state_dir)
  set(output, 'AGENT_MESH_NETWORK_ID', mesh.network_id)
  set(output, 'AGENT_MESH_NODE_NAME', mesh.node_name)
  setList(output, 'AGENT_MESH_LISTEN', mesh.listen)
  setList(output, 'AGENT_MESH_BOOTSTRAP', mesh.bootstrap)
  setList(output, 'AGENT_MESH_ALLOW_PEERS', mesh.allow_peers)
  setList(output, 'AGENT_MESH_PRIVATE_NETWORKS', mesh.private_networks)
  if (mesh.allow_all_peers !== undefined) output.AGENT_MESH_ALLOW_ALL_PEERS = mesh.allow_all_peers === true ? '1' : '0'
  set(output, 'AGENT_MESH_INGRESS_MBPS', capacity.ingress_mbps)
  set(output, 'AGENT_MESH_EGRESS_MBPS', capacity.egress_mbps)
  set(output, 'AGENT_MESH_REGION', capacity.region)
  set(output, 'AGENT_MESH_ZONE', capacity.zone)
  set(output, 'AGENT_MESH_IDLE_PRICE_PER_GIB', capacity.idle_price_per_gib)
  set(output, 'AGENT_MESH_BUSY_PRICE_PER_GIB', capacity.busy_price_per_gib)
  return output
}

function set(target, key, value) {
  if (value !== undefined && value !== null) target[key] = String(value)
}

function setList(target, key, value) {
  if (Array.isArray(value)) target[key] = value.join(',')
}

function assertHarnessCheckout() {
  const manifest = join(harnessRepo, 'package.json')
  if (!existsSync(manifest)) throw new Error(`DeepSeek Harness checkout not found at ${harnessRepo}; set DSH_REPO`)
  const compatibility = JSON.parse(readFileSync(join(root, 'compat', 'harness.json'), 'utf8'))
  const actual = JSON.parse(readFileSync(manifest, 'utf8')).version
  if (actual !== compatibility.version) {
    throw new Error(`Harness ${actual} is incompatible; this checkout expects ${compatibility.version}`)
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRepo, encoding: 'utf8' })
  if (revision.status === 0 && revision.stdout.trim() !== compatibility.commit) {
    throw new Error(`Harness commit ${revision.stdout.trim()} is incompatible; expected ${compatibility.commit}`)
  }
}

function buildWorkspace() {
  run('cargo', ['build', '--workspace', '--release'], root)
  run('pnpm', ['-r', '--if-present', 'build'], root)
}

function installPlugins() {
  for (const path of ['packages/dsh-agent-mesh', 'packages/dsh-agent-mesh-web']) {
    runDsh(['plugin', '--profile', profile, 'add', join(root, path)])
  }
}

function runDsh(args) {
  run('pnpm', ['dsh', ...args], harnessRepo)
}

async function runDshWeb(args) {
  const child = spawn('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args], {
    cwd: harnessRepo,
    env,
    stdio: 'inherit',
  })
  const forward = signal => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  process.removeListener('SIGINT', forward)
  process.removeListener('SIGTERM', forward)
  if (outcome.signal !== null) process.exitCode = 1
  else process.exitCode = outcome.code ?? 1
}

function run(command, args, cwd) {
  const outcome = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (outcome.error) throw outcome.error
  if (outcome.status !== 0) process.exit(outcome.status ?? 1)
}
