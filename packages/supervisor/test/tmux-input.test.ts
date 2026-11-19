import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { sendTmuxInput } from '../src/process-manager.js'
import type { Session } from '../src/types.js'

// Real tmux on the bridge socket, throwaway session only. Never kill-server here:
// that would take down the live Claude sessions.
const tmux = (...args: string[]): string =>
  execFileSync('tmux', ['-L', 'claude-matrix-bridge', '-f', '/dev/null', ...args], { encoding: 'utf-8' })

describe('sendTmuxInput', () => {
  it('types a flattened, dash-leading message into the pane and presses Enter', async () => {
    const name = `test-input-${process.pid}`
    tmux('new-session', '-d', '-s', `claude-${name}`, 'cat')
    try {
      await sendTmuxInput({ name } as Session, '-dash hello\nline two')
      await new Promise(r => setTimeout(r, 300))
      const pane = tmux('capture-pane', '-p', '-t', `claude-${name}`)
      assert.match(pane, /-dash hello line two/)
    } finally {
      tmux('kill-session', '-t', `claude-${name}`)
    }
  })
})
