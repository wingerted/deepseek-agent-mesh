import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'artifacts')
mkdirSync(destination, { recursive: true })

run(['-r', '--if-present', 'build'])
for (const path of ['packages/mesh-rpc', 'packages/dsh-agent-mesh', 'packages/dsh-agent-mesh-web']) {
  run(['--dir', path, 'pack', '--pack-destination', destination])
}

function run(args) {
  const outcome = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' })
  if (outcome.error) throw outcome.error
  if (outcome.status !== 0) process.exit(outcome.status ?? 1)
}
