import assert from 'node:assert/strict'
import test from 'node:test'

const entries = [
  '../service.js', '../leader.js', '../leader-provider.js', '../guidance.js',
  '../leader-tools.js', '../tools.js', '../inbox.js',
]

test('every published Host entry resolves with its runtime dependencies', async () => {
  for (const entry of entries) {
    const plugin = await import(entry)
    assert.equal(typeof plugin.apply, 'function', entry)
  }
})
