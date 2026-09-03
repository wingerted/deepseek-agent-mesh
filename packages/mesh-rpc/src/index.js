import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export async function meshCall(stateDir, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 35_000
  const control = JSON.parse(await readFile(join(stateDir, 'control.json'), 'utf8'))
  if (control.version !== 1 || typeof control.address !== 'string' || typeof control.token !== 'string') {
    throw new Error('invalid agent-mesh control file')
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(parseAddress(control.address))
    let settled = false
    let response = ''
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error('mesh call aborted'))
    const timer = setTimeout(() => finish(new Error(`mesh call ${method} timed out`)), timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) return abort()
    socket.setEncoding('utf8')
    socket.once('error', error => finish(error))
    socket.on('data', chunk => {
      response += chunk
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) return finish(new Error('mesh response exceeds 16 MiB'))
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const decoded = JSON.parse(response.slice(0, newline))
        if (decoded.ok) finish(null, decoded.result)
        else finish(new Error(decoded.error || 'mesh daemon error'))
      } catch (error) {
        finish(error)
      }
    })
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token: control.token, method, params })}\n`)
    })
  })
}

function parseAddress(value) {
  const separator = value.lastIndexOf(':')
  if (separator <= 0) throw new Error(`invalid mesh control address: ${value}`)
  return { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) }
}
