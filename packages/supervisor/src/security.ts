import { createHmac, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'

export function relayToken(sessionId: string): string {
  const master = process.env.CMB_RELAY_SECRET
  if (!master || !/^[a-f0-9]{64}$/i.test(master)) {
    throw new Error('CMB_RELAY_SECRET must be a random 64-character hex string')
  }
  return createHmac('sha256', Buffer.from(master, 'hex')).update(sessionId).digest('hex')
}

export function bearerValid(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const received = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function handoffToken(): string {
  const path = process.env.CMB_HANDOFF_TOKEN_FILE ??
    join(homedir(), '.config', 'claude-matrix-bridge', 'handoff-token')
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o077)) {
    throw new Error('Handoff token must be a private 0600 file: ' + path)
  }
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid handoff token')
  return token
}
