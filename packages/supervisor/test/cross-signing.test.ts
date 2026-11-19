import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureCrossSigning } from '../src/bot.js'

const USER = '@bot:example.org'
const DEVICE = 'BOTDEV'

// /keys/query shapes: device signed by the self-signing key, or signed by the device key only.
const signed = {
  master_keys: { [USER]: { keys: { 'ed25519:MASTER': 'MASTER' } } },
  self_signing_keys: { [USER]: { keys: { 'ed25519:SELF': 'SELF' } } },
  device_keys: { [USER]: { [DEVICE]: { signatures: { [USER]: { 'ed25519:SELF': 'sig' } } } } },
}
const unsigned = {
  master_keys: signed.master_keys,
  self_signing_keys: signed.self_signing_keys,
  device_keys: { [USER]: { [DEVICE]: { signatures: { [USER]: { 'ed25519:DEVICE': 'sig' } } } } },
}

function fakeClient(server: () => object, bootstrap: () => Promise<void>) {
  return {
    getUserId: async () => USER,
    doRequest: async () => server(),
    crypto: { clientDeviceId: DEVICE, engine: { machine: { bootstrapCrossSigning: bootstrap } } },
  } as any
}

function recorder() {
  const warnings: unknown[] = []
  return { info() {}, warn: (...args: unknown[]) => warnings.push(args), warnings }
}

test('does nothing when the homeserver already shows the device cross-signed', async () => {
  let calls = 0
  const logger = recorder()
  await ensureCrossSigning(fakeClient(() => signed, async () => { calls++ }), logger as any)
  assert.equal(calls, 0)
  assert.equal(logger.warnings.length, 0)
})

test('bootstraps when the device is not cross-signed, then re-checks the server', async () => {
  let server: object = unsigned
  let calls = 0
  const logger = recorder()
  await ensureCrossSigning(fakeClient(() => server, async () => { calls++; server = signed }), logger as any)
  assert.equal(calls, 1)
  assert.equal(logger.warnings.length, 0)
})

test('warns when the device is still unsigned after bootstrap', async () => {
  const logger = recorder()
  await ensureCrossSigning(fakeClient(() => unsigned, async () => {}), logger as any)
  assert.equal(logger.warnings.length, 1)
})

test('a failing bootstrap is logged and does not throw', async () => {
  const logger = recorder()
  await ensureCrossSigning(fakeClient(() => unsigned, async () => { throw new Error('UIA required') }), logger as any)
  assert.equal(logger.warnings.length, 1)
})
