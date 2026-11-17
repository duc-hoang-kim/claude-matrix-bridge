import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bearerValid, relayToken } from '../src/security.js'
import { nextFreePort, releasePort } from '../src/database.js'

test('relay credentials are unique per session and reject wrong tokens', () => {
  const old = process.env.CMB_RELAY_SECRET
  process.env.CMB_RELAY_SECRET = 'ab'.repeat(32)
  try {
    const one = relayToken('session-one')
    const two = relayToken('session-two')
    assert.equal(one.length, 64)
    assert.notEqual(one, two)
    assert.equal(bearerValid('Bearer ' + one, one), true)
    assert.equal(bearerValid('Bearer ' + two, one), false)
    assert.equal(bearerValid('Bearer ', one), false)
    assert.equal(bearerValid(undefined, one), false)
  } finally {
    if (old === undefined) delete process.env.CMB_RELAY_SECRET
    else process.env.CMB_RELAY_SECRET = old
  }
})

test('port reserved by spawning session cannot be assigned twice', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE sessions (status TEXT, port INTEGER, created_at TEXT)')
  db.prepare('INSERT INTO sessions (status, port, created_at) VALUES (?, ?, ?)').run('spawning', 19001, 'now')
  try {
    const first = nextFreePort(db, 19001, 19003)
    const second = nextFreePort(db, 19001, 19003)
    assert.equal(first, 19002)
    assert.equal(second, 19003)
    assert.equal(nextFreePort(db, 19001, 19003), null)
    releasePort(first!)
    releasePort(second!)
  } finally {
    db.close()
  }
})
