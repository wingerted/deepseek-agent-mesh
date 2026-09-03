import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const prefix = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('usage: node test-conda-runtime.mjs <prefix>')

const dshHome = mkdtempSync(join(tmpdir(), 'agent-mesh-conda-runtime-'))
const interfaces = Object.entries(networkInterfaces())
  .flatMap(([name, entries]) => (entries || []).map(entry => ({ name, ...entry })))
  .filter(entry => entry.family === 'IPv4' && !entry.internal)
const testHost = interfaces.find(entry => /^(en|eth|ens)/i.test(entry.name))?.address
  || interfaces[0]?.address
if (!testHost) throw new Error('Conda runtime test requires a configured non-loopback IPv4 address')
const child = spawn(join(prefix, 'bin', 'dsh-mesh'), [
  'up',
  '--bind',
  testHost,
  '--name',
  'conda-runtime-test',
], {
  env: {
    ...process.env,
    PATH: `${join(prefix, 'bin')}:${process.env.PATH || ''}`,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', chunk => { output = `${output}${chunk}`.slice(-64 * 1024) })
}

try {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Harness exited with ${child.exitCode}\n${output}`)
    if (await portOpen(testHost, 8787)) {
      process.stdout.write(`packaged Harness Web accepted non-loopback IP ${testHost}\n`)
      break
    }
    await delay(250)
  }
  if (!(await portOpen(testHost, 8787))) {
    throw new Error(`Harness Web did not listen within 60 seconds\n${output}`)
  }
} finally {
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    delay(5_000).then(() => child.kill('SIGKILL')),
  ])
  rmSync(dshHome, { recursive: true, force: true })
}

function portOpen(host, port) {
  return new Promise(resolveOpen => {
    const socket = connect({ host, port })
    socket.setTimeout(250)
    socket.once('connect', () => { socket.destroy(); resolveOpen(true) })
    socket.once('timeout', () => { socket.destroy(); resolveOpen(false) })
    socket.once('error', () => resolveOpen(false))
  })
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}
