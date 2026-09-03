#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(scriptDir, '..')

export function parseJoinCode(code) {
  if (!code?.startsWith('mesh1:')) throw new Error('join code must start with mesh1:')
  const ticket = JSON.parse(Buffer.from(code.slice(6), 'base64url').toString('utf8'))
  if (ticket.version !== 1 || !ticket.network_id || !Array.isArray(ticket.bootstrap)) {
    throw new Error('unsupported or invalid join code')
  }
  return ticket
}

export function chooseBindAddress(explicit, target) {
  if (explicit) return explicit
  const candidates = Object.entries(networkInterfaces())
    .flatMap(([name, entries]) => (entries || []).map(entry => ({ name, ...entry })))
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
  if (target) {
    const routed = routeSource(target)
    if (routed) return routed
  }
  const preferred = candidates.find(entry => /^(wg|utun|tailscale)/i.test(entry.name))
  if (preferred) return preferred.address
  const privateAddress = candidates.find(entry => isPrivateIpv4(entry.address))
  if (privateAddress) return privateAddress.address
  return candidates[0]?.address || '127.0.0.1'
}

export function createNodeConfig({ bind, networkId, bootstrap = [], name = hostname() }) {
  return {
    version: 1,
    bind,
    networkId,
    bootstrap,
    name,
    meshPort: 41001,
    webPort: 8787,
    ingressMbps: 100,
    egressMbps: 100,
    region: 'local',
    zone: 'default',
    privateNetworks: isPrivateIpv4(bind) ? ['wireguard'] : [],
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv.shift() || 'help'
  const options = parseOptions(argv)
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  const stateDir = resolve(process.env.AGENT_MESH_STATE_DIR || join(dshHome, 'agent-mesh'))
  const configPath = join(stateDir, 'node.json')
  const meshBin = findMeshBinary()

  if (command === 'join') {
    const code = options.positionals[0]
    const ticket = parseJoinCode(code)
    const target = firstIp(ticket.bootstrap)
    const bind = chooseBindAddress(options.bind, target)
    run(meshBin, ['--state-dir', stateDir, 'join', code])
    const config = createNodeConfig({
      bind,
      networkId: ticket.network_id,
      bootstrap: ticket.bootstrap,
      name: options.name,
    })
    writePrivateJson(configPath, config)
    await startHarness({ config, dshHome, stateDir, meshBin, printInvite: false })
    return
  }

  if (command === 'up') {
    let config
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } else {
      const bind = chooseBindAddress(options.bind)
      config = createNodeConfig({
        bind,
        networkId: options.network || `mesh-${crypto.randomUUID().slice(0, 12)}`,
        name: options.name,
      })
      writePrivateJson(configPath, config)
    }
    if (options.bind) config.bind = options.bind
    if (options.name) config.name = options.name
    writePrivateJson(configPath, config)
    await startHarness({
      config,
      dshHome,
      stateDir,
      meshBin,
      printInvite: options.new === true,
    })
    return
  }

  if (command === 'invite') {
    const ttl = String(options.ttl || 900)
    const result = runCapture(meshBin, [
      '--state-dir',
      stateDir,
      'invite',
      '--ttl-seconds',
      ttl,
    ])
    const value = JSON.parse(result)
    process.stdout.write(`${value.join_code}\n`)
    return
  }

  if (command === 'status' || command === 'peers') {
    run(meshBin, ['--state-dir', stateDir, command])
    return
  }

  printHelp()
  if (command !== 'help' && command !== '--help' && command !== '-h') process.exitCode = 2
}

async function startHarness({ config, dshHome, stateDir, meshBin, printInvite }) {
  const runtime = findHarnessRuntime()
  const plugins = findPlugins()
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED || '1',
    AGENT_MESH_BIN: meshBin,
    AGENT_MESH_STATE_DIR: stateDir,
    AGENT_MESH_NETWORK_ID: config.networkId,
    AGENT_MESH_NODE_NAME: config.name,
    AGENT_MESH_LISTEN: [
      `/ip4/${config.bind}/tcp/${config.meshPort}`,
      `/ip4/${config.bind}/udp/${config.meshPort}/quic-v1`,
    ].join(','),
    AGENT_MESH_BOOTSTRAP: config.bootstrap.join(','),
    AGENT_MESH_PRIVATE_NETWORKS: config.privateNetworks.join(','),
    AGENT_MESH_INGRESS_MBPS: String(config.ingressMbps),
    AGENT_MESH_EGRESS_MBPS: String(config.egressMbps),
    AGENT_MESH_REGION: config.region,
    AGENT_MESH_ZONE: config.zone,
  }
  for (const plugin of plugins) {
    run(runtime.command, [...runtime.prefix, 'plugin', '--profile', 'web', 'add', plugin], {
      cwd: runtime.cwd,
      env,
    })
  }
  const child = spawn(
    runtime.command,
    [
      ...runtime.prefix,
      'web',
      '--host',
      config.bind,
      '--port',
      String(config.webPort),
      '--no-open',
    ],
    { cwd: runtime.cwd, env, stdio: 'inherit' },
  )
  const forward = signal => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  if (printInvite) {
    try {
      await waitForFile(join(stateDir, 'control.json'), 20_000)
      const output = runCapture(meshBin, [
        '--state-dir',
        stateDir,
        'invite',
        '--ttl-seconds',
        '900',
      ])
      const invite = JSON.parse(output)
      process.stderr.write(`\nJoin code (valid for 15 minutes, one use):\n${invite.join_code}\n\n`)
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
  }
  const outcome = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  process.removeListener('SIGINT', forward)
  process.removeListener('SIGTERM', forward)
  if (outcome.signal) process.exitCode = 1
  else process.exitCode = outcome.code ?? 1
}

function findMeshBinary() {
  if (process.env.AGENT_MESH_BIN) return resolve(process.env.AGENT_MESH_BIN)
  const sourceBinary = join(sourceRoot, 'target', 'release', 'agent-mesh')
  if (existsSync(sourceBinary)) return sourceBinary
  const adjacentBinary = join(scriptDir, 'agent-mesh')
  if (existsSync(adjacentBinary)) return adjacentBinary
  const prefixBinary = resolve(scriptDir, '..', '..', 'bin', 'agent-mesh')
  if (existsSync(prefixBinary)) return prefixBinary
  return 'agent-mesh'
}

function findHarnessRuntime() {
  if (process.env.DSH_BIN) {
    return { command: resolve(process.env.DSH_BIN), prefix: [], cwd: process.cwd() }
  }
  const packagedRoots = [
    scriptDir,
    resolve(scriptDir, '..', 'libexec', 'agent-mesh'),
  ]
  for (const packagedRoot of packagedRoots) {
    const packaged = join(packagedRoot, 'node_modules', '.bin', 'dsh')
    if (existsSync(packaged)) return { command: packaged, prefix: [], cwd: packagedRoot }
  }
  const repository = resolve(process.env.DSH_REPO || join(sourceRoot, '..', 'deepseek-harness'))
  if (existsSync(join(repository, 'package.json'))) {
    return { command: 'pnpm', prefix: ['--dir', repository, 'dsh'], cwd: repository }
  }
  throw new Error('DeepSeek Harness runtime is unavailable; install the Conda package or set DSH_BIN')
}

function findPlugins() {
  const localPackaged = join(scriptDir, 'plugins')
  const prefixPackaged = resolve(scriptDir, '..', 'libexec', 'agent-mesh', 'plugins')
  const packaged = existsSync(localPackaged) ? localPackaged : prefixPackaged
  const root = existsSync(packaged) ? packaged : join(sourceRoot, 'packages')
  const plugins = [join(root, 'dsh-agent-mesh'), join(root, 'dsh-agent-mesh-web')]
  for (const plugin of plugins) {
    if (!existsSync(join(plugin, 'package.json'))) throw new Error(`plugin is unavailable: ${plugin}`)
  }
  return plugins
}

function parseOptions(args) {
  const output = { positionals: [] }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--new') output.new = true
    else if (value === '--bind') output.bind = requireValue(args, ++index, value)
    else if (value === '--name') output.name = requireValue(args, ++index, value)
    else if (value === '--network') output.network = requireValue(args, ++index, value)
    else if (value === '--ttl') output.ttl = Number(requireValue(args, ++index, value))
    else if (value.startsWith('-')) throw new Error(`unknown option ${value}`)
    else output.positionals.push(value)
  }
  return output
}

function requireValue(args, index, option) {
  if (!args[index]) throw new Error(`${option} requires a value`)
  return args[index]
}

function firstIp(addresses) {
  for (const address of addresses) {
    const match = address.match(/\/ip4\/([^/]+)/)
    if (match) return match[1]
  }
  return undefined
}

function routeSource(target) {
  const commands = process.platform === 'darwin'
    ? [['route', ['-n', 'get', target], /(?:interface|source):\s*(\S+)/g]]
    : [['ip', ['route', 'get', target], /\bsrc\s+(\S+)/]]
  for (const [command, args, pattern] of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status !== 0) continue
    if (process.platform === 'darwin') {
      const source = result.stdout.match(/source:\s*(\S+)/)?.[1]
      if (source) return source
      const interfaceName = result.stdout.match(/interface:\s*(\S+)/)?.[1]
      const entry = networkInterfaces()[interfaceName]?.find(item => item.family === 'IPv4')
      if (entry) return entry.address
    } else {
      const match = result.stdout.match(pattern)
      if (match) return match[1]
    }
  }
  return undefined
}

function isPrivateIpv4(address) {
  const bytes = String(address).split('.').map(Number)
  return bytes.length === 4
    && (bytes[0] === 10
      || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
      || (bytes[0] === 192 && bytes[1] === 168)
      || bytes[0] === 127)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`)
  return result.stdout
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

async function waitForFile(path, timeoutMs) {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
}

function printHelp() {
  process.stdout.write(`dsh-mesh - DeepSeek Harness Leader mesh\n\n`)
  process.stdout.write(`  dsh-mesh up --new [--bind IP]    create/start and print one invite\n`)
  process.stdout.write(`  dsh-mesh join <mesh1:...>        join and start immediately\n`)
  process.stdout.write(`  dsh-mesh invite [--ttl SEC]      print a one-use invite\n`)
  process.stdout.write(`  dsh-mesh status                   show local daemon status\n`)
  process.stdout.write(`  dsh-mesh peers                    show discovered peers\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`dsh-mesh: ${error.message}\n`)
    process.exitCode = 1
  })
}
