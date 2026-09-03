import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(packageDir, '..', 'mesh-rpc', 'src', 'index.js')
const target = resolve(packageDir, 'lib', 'rpc.js')

await mkdir(dirname(target), { recursive: true })
await writeFile(target, await readFile(source, 'utf8'))
