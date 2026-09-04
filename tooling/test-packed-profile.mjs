import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRepo = resolve(process.env.DSH_REPO || join(root, '..', 'deepseek-harness'))
const compatibility = JSON.parse(readFileSync(join(root, 'compat', 'harness.json'), 'utf8'))
const harnessVersion = JSON.parse(readFileSync(join(harnessRepo, 'package.json'), 'utf8')).version
if (harnessVersion !== compatibility.version) throw new Error(`expected Harness ${compatibility.version}, found ${harnessVersion}`)

const dshHome = mkdtempSync(join(tmpdir(), 'agent-mesh-packed-profile-'))
const env = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }

try {
  for (const archive of [
    'dsh-agent-mesh-0.2.0.tgz',
    'dsh-agent-mesh-web-0.2.0.tgz',
  ]) {
    run(['plugin', '--profile', 'web', 'add', join(root, 'artifacts', archive)])
  }
  const output = run(['--profile', 'web', '--dump-config'], true)
  for (const marker of ['# == dsh-agent-mesh', '# == dsh-agent-mesh-web']) {
    if (!output.includes(marker)) throw new Error(`packed profile is missing ${marker}`)
  }
  process.stdout.write('packed Harness profile passed\n')
} finally {
  rmSync(dshHome, { recursive: true, force: true })
}

function run(args, capture = false) {
  const outcome = spawnSync('pnpm', ['dsh', ...args], {
    cwd: harnessRepo,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
  if (outcome.error) throw outcome.error
  if (outcome.status !== 0) process.exit(outcome.status ?? 1)
  return capture ? outcome.stdout : ''
}
