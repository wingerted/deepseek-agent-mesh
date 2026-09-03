import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseBindAddress, createNodeConfig, parseJoinCode } from './dsh-mesh.mjs'

test('parses the public fields needed to bootstrap a signed join code', () => {
  const ticket = {
    version: 1,
    network_id: 'team-a',
    bootstrap: ['/ip4/10.0.0.1/tcp/41001/p2p/12D3KooWExample'],
  }
  const code = `mesh1:${Buffer.from(JSON.stringify(ticket)).toString('base64url')}`
  assert.deepEqual(parseJoinCode(code), ticket)
})

test('explicit bind address wins and creates a private-network config', () => {
  assert.equal(chooseBindAddress('10.20.30.40'), '10.20.30.40')
  assert.deepEqual(
    createNodeConfig({ bind: '10.20.30.40', networkId: 'team-a', name: 'node-b' }),
    {
      version: 1,
      bind: '10.20.30.40',
      networkId: 'team-a',
      bootstrap: [],
      name: 'node-b',
      meshPort: 41001,
      webPort: 8787,
      ingressMbps: 100,
      egressMbps: 100,
      region: 'local',
      zone: 'default',
      privateNetworks: ['wireguard'],
    },
  )
})
