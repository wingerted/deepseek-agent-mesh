import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { meshCall } from '../src/index.js'

test('client authenticates and returns the canonical result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asym-plugin-'))
  const server = net.createServer(socket => {
    socket.once('data', data => {
      const request = JSON.parse(String(data).trim())
      assert.equal(request.token, 'secret')
      assert.equal(request.method, 'status')
      socket.end(`${JSON.stringify({ ok: true, result: { peer_id: 'peer' } })}\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await writeFile(join(root, 'control.json'), JSON.stringify({
    version: 1,
    address: `127.0.0.1:${address.port}`,
    token: 'secret',
    peer_id: 'peer',
  }))
  assert.deepEqual(await meshCall(root, 'status'), { peer_id: 'peer' })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

test('client surfaces daemon errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asym-plugin-'))
  const server = net.createServer(socket => {
    socket.once('data', () => socket.end(`${JSON.stringify({ ok: false, error: 'denied' })}\n`))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await writeFile(join(root, 'control.json'), JSON.stringify({
    version: 1,
    address: `127.0.0.1:${address.port}`,
    token: 'secret',
    peer_id: 'peer',
  }))
  await assert.rejects(meshCall(root, 'status'), /denied/)
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})
