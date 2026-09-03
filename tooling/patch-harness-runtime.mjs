import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const runtime = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('usage: node patch-harness-runtime.mjs <runtime>')

const webserver = join(
  runtime,
  'node_modules',
  '@deepseek-ai',
  'dsh-host-webserver',
  'lib',
  'index.js',
)
const source = readFileSync(webserver, 'utf8')
const legacy = 'host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),'
const replacement = 'host: z.string().required(),'
const occurrences = source.split(legacy).length - 1
if (occurrences !== 1) {
  throw new Error(`expected exactly one legacy Harness listen-host schema, found ${occurrences}`)
}
writeFileSync(webserver, source.replace(legacy, replacement))
process.stdout.write('patched Harness webserver to accept the IP literal validated by dsh web\n')
