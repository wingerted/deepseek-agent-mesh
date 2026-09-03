import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(root, 'src/client.cjs'), 'utf8')
const output = `window.__ModuleLoader__.load({
  id: "dsh-agent-mesh-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${source.split('\n').map(line => `    ${line}`).join('\n')}
    return module.exports(require);
  }
});
`
await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/client.js'), output)
