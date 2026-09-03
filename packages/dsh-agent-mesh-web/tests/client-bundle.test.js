import assert from 'node:assert/strict'
import test from 'node:test'

test('built client registers a lazy browser module and contributes the Mesh settings tab', async () => {
  let registration
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
  await import(`../lib/client.js?test=${Date.now()}`)
  assert.equal(registration.id, 'dsh-agent-mesh-web')

  const React = {
    createElement() {}, useEffect() {}, useMemo(value) { return value() }, useState(value) { return [value, () => {}] },
  }
  const plugin = registration.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale'])

  let tab
  const ctx = {
    effect() {},
    locale: { register() {}, bind() { return key => key } },
    slots: {
      inject(name, mount) { assert.equal(name, 'settings.plugins.tab'); mount() },
      register(options, component) { tab = { options, component } },
    },
  }
  plugin.apply(ctx)
  assert.equal(tab.options.id, 'mesh')
  assert.equal(tab.options.label(), 'tab')
  assert.equal(tab.component, plugin.MeshNetworkTab)
  delete globalThis.window
})
