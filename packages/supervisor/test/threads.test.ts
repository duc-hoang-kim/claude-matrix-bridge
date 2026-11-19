import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, runMigrations, createSession, getSessionByThread, getAllSessions, setConfig } from '../src/database.js'
import { resolveThreadSession } from '../src/bot.js'
import type { Config } from '../src/config.js'
import type { Session } from '../src/types.js'

const mk = (id: string, thread_root: string | null): Session => ({
  id, room_id: '!r:x', name: id, working_directory: '/tmp', model: 'sonnet',
  permission_mode: 'default', port: null, pid: null, status: 'detached',
  created_at: '', updated_at: '', last_message_at: null, local_pid: null,
  last_matrix_activity: null, thread_root,
})

test('two sessions can share a room, one per thread', () => {
  const db = openDatabase(':memory:')
  runMigrations(db)
  createSession(db, mk('a', '$1'))
  createSession(db, mk('b', '$2'))
  assert.equal(getAllSessions(db).length, 2)
  assert.equal(getSessionByThread(db, '!r:x', '$2')?.id, 'b')
})

test('chat in a room with no session opens one, then one per thread; the space never does', () => {
  const db = openDatabase(':memory:')
  runMigrations(db)
  const config = { claude: { model: 'sonnet', defaultWorkDir: process.cwd(), defaultMode: 'auto' } } as unknown as Config
  const first = resolveThreadSession(db, '!alert:x', '$t1', config)
  assert.equal(first?.thread_root, '$t1')
  assert.equal(first?.working_directory, process.cwd())
  const second = resolveThreadSession(db, '!alert:x', '$t2', config)
  assert.notEqual(second?.id, first?.id)
  assert.equal(resolveThreadSession(db, '!alert:x', '$t1', config)?.id, first?.id)
  assert.equal(getAllSessions(db).length, 2)
  setConfig(db, 'space_id', '!space:x')
  assert.equal(resolveThreadSession(db, '!space:x', '$s', config), undefined)
})
