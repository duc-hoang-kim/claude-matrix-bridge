import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { relayToken } from './security.js'
import type { Logger } from 'pino'
import type Database from 'better-sqlite3'
import type { Session, UserPermissionMode } from './types.js'
import { updateSession, expireSessionPermissions } from './database.js'

/**
 * Dedicated tmux socket for the bridge. Separates our sessions from the
 * user's normal tmux (visible only via `tmux -L claude-matrix-bridge ls`).
 */
const TMUX_SOCKET = 'claude-matrix-bridge'

/**
 * MCP config for matrix-relay, passed to each spawned session with
 * --strict-mcp-config, so sessions load only the relay. Written by
 * scripts/register-relay.sh; nothing is registered at user scope.
 */
// Opt-in: CMB_SLACK_CONNECTOR=1 reuses the logged-in claude.ai Slack connector (read-only tools
// allowlisted). Needs --strict-mcp-config off, so ALL claude.ai connectors load; only these tools
// are pre-approved. ponytail: no per-connector filter in claude, so other connectors prompt/deny by mode.
// Read at spawn time: .env is loaded by loadConfig(), after this module is imported.
const slackConnector = (): boolean => process.env.CMB_SLACK_CONNECTOR === '1'
const SLACK_READ_TOOLS = ['search_public', 'search_public_and_private', 'search_users', 'search_channels',
  'read_channel', 'read_thread', 'read_user_profile', 'read_canvas'].map(t => `mcp__claude_ai_Slack__slack_${t}`)
const RELAY_MCP_CONFIG = join(homedir(), '.config', 'claude-matrix-bridge', 'relay-mcp.json')

/**
 * Prepend socket and "no config" flags so our tmux server never loads
 * the user's ~/.tmux.conf (would pull in continuum/resurrect/etc.).
 * Once the server is running, -f is ignored by subsequent commands,
 * but including it is harmless and keeps calls uniform.
 */
function tmuxArgs(...args: string[]): string[] {
  return ['-L', TMUX_SOCKET, '-f', '/dev/null', ...args]
}

// Track active tmux session names for cleanup
export const activeSessions = new Set<string>()

function tmuxSessionName(session: Session): string {
  return `claude-${session.name}`
}

/**
 * Kill the entire dedicated tmux server. Used for recovery on startup
 * to guarantee a clean slate. Silent if the server doesn't exist.
 */
export function killTmuxServer(logger: Logger): void {
  try {
    execFileSync('tmux', tmuxArgs('kill-server'), {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    logger.info({ socket: TMUX_SOCKET }, 'Killed stale tmux server on startup')
  } catch {
    // Server didn't exist — fine
  }
}

/**
 * Verify that matrix-relay is registered as an MCP server. Does NOT register
 * it — that's the job of `scripts/register-relay.sh` (via `mise run setup`
 * or `mise run dev` which depends on `register-relay`).
 *
 * Throws if not registered, so the supervisor fails fast with a clear message.
 */
export function checkRelayRegistered(logger: Logger): void {
  try {
    const config = JSON.parse(readFileSync(RELAY_MCP_CONFIG, 'utf-8')) as {
      mcpServers?: Record<string, unknown>
    }
    if (config.mcpServers && 'matrix-relay' in config.mcpServers) {
      logger.debug({ config: RELAY_MCP_CONFIG }, 'matrix-relay MCP config found')
      return
    }
  } catch {
    // missing or unreadable config — treat as not registered
  }

  throw new Error(
    `matrix-relay MCP config missing at ${RELAY_MCP_CONFIG}. Run "mise run register-relay" or "mise run setup" first.`,
  )
}

export function spawnClaude(
  session: Session,
  _config: unknown,
  db: Database.Database,
  logger: Logger,
  options?: { resume?: boolean; onExit?: (code: number | null) => void },
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session.name)) {
    throw new Error('Unsafe session name (letters, numbers, underscore and hyphen only)')
  }
  const tmuxName = tmuxSessionName(session)
  const sessionLogger = logger.child({ session: session.name, port: session.port, tmux: tmuxName })

  // Build the claude command to run inside tmux
  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:matrix-relay',
    '--model', session.model,
    // Auto-allow relay tools so Claude doesn't prompt in tmux
    '--allowedTools', [
      'mcp__matrix-relay__reply', 'mcp__matrix-relay__react',
      ...(slackConnector() ? SLACK_READ_TOOLS : []),
    ].join(' '),
    // Load only the relay, not the user's global MCP servers
    '--mcp-config', RELAY_MCP_CONFIG,
    // Slack connector is a claude.ai account server; strict mode would hide it.
    ...(slackConnector() ? [] : ['--strict-mcp-config']),
  ]

  if (options?.resume) {
    // Resume existing session — don't pass --session-id (conflicts with --resume)
    claudeArgs.push('--resume', session.id)
  } else {
    // New session
    claudeArgs.push('--session-id', session.id, '--name', session.name)
  }

  if (session.permission_mode === 'bypassPermissions') {
    throw new Error('Unsafe bypassPermissions mode is disabled')
  }
  claudeArgs.push('--permission-mode', session.permission_mode)

  if (!session.port || !Number.isInteger(session.port)) throw new Error('Missing relay port')
  sessionLogger.info({ cwd: session.working_directory, model: session.model }, 'Spawning Claude in tmux')

  // Kill stale tmux session with same name if it exists
  try {
    execFileSync('tmux', tmuxArgs('kill-session', '-t', tmuxName), {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessionLogger.info('Killed stale tmux session')
  } catch {
    // No existing session — expected
  }

  // Create a detached tmux session running claude
  try {
    execFileSync('tmux', tmuxArgs(
      'new-session',
      '-d',                    // detached
      '-s', tmuxName,          // session name
      '-c', session.working_directory,  // working directory
      '-e', `RELAY_PORT=${session.port}`,
      '-e', `RELAY_SESSION_ID=${session.id}`,
      '-e', `RELAY_AUTH_TOKEN=${relayToken(session.id)}`,
      'claude', ...claudeArgs, // argument vector, never a shell command
    ), {
      encoding: 'utf-8',
      timeout: 10000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('MATRIX_') && key !== 'CMB_RELAY_SECRET'
      )),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sessionLogger.error({ err: msg }, 'Failed to create tmux session')
    throw new Error(`Failed to start Claude tmux session: ${msg}`)
  }

  activeSessions.add(session.id)

  // Auto-confirm first-launch prompts. Fresh workdirs show Claude Code's trust
  // prompt ("Is this a project you created or trust") before the dev-channels
  // prompt. We handle trust first (if present) and keep polling for dev-channels.
  // Prompts we don't recognise block indefinitely; on timeout we dump the pane
  // content so future unknown prompts surface immediately in the logs.
  void (async () => {
    const maxAttempts = 40 // 40 * 500ms = 20s max wait
    const sendEnter = (): void => {
      execFileSync('tmux', tmuxArgs('send-keys', '-t', tmuxName, 'Enter'), {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    }

    const capturePane = (): string | null => {
      try {
        return execFileSync('tmux', tmuxArgs('capture-pane', '-t', tmuxName, '-p'), {
          encoding: 'utf-8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        // tmux session might not be ready yet
        return null
      }
    }

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500))
      const pane = capturePane()
      if (pane === null) continue

      // Match the highlighted option text rather than the question wording —
      // the question phrasing ("Is this a project you created or one you trust?")
      // contains "one you" between "or" and "trust" and is more likely to drift
      // across Claude Code versions. The option text "Yes, I trust this folder"
      // is the stable anchor.
      if (pane.includes('Yes, I trust this folder')) {
        sessionLogger.warn('Project trust requires local manual approval in tmux')
        return
      }
      if (pane.includes('I am using this for local development')) {
        sendEnter()
        sessionLogger.info('Auto-confirmed development channels prompt')
        return
      }
      if (pane.includes('Listening for channel messages')) {
        sessionLogger.debug('Channel already active, no confirmation needed')
        return
      }
    }

    const finalPane = capturePane()
    sessionLogger.warn(
      { pane: finalPane?.slice(-500) ?? null },
      'Spawn-polling timed out without reaching dev-channels prompt',
    )
  })()

  // Get the PID of the claude process inside tmux
  try {
    const paneInfo = execFileSync('tmux', tmuxArgs(
      'list-panes', '-t', tmuxName, '-F', '#{pane_pid}',
    ), { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

    const pid = Number(paneInfo)
    if (pid) {
      updateSession(db, session.id, { pid })
      sessionLogger.info({ pid }, 'Claude tmux session started')
    }
  } catch {
    sessionLogger.warn('Could not get tmux pane PID')
  }

  // Monitor tmux session — poll for exit
  let misses = 0
  const pollInterval = setInterval(() => {
    try {
      execFileSync('tmux', tmuxArgs('has-session', '-t', tmuxName), {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      misses = 0
    } catch {
      if (++misses < 2) return // one transient has-session failure isn't an exit
      clearInterval(pollInterval)
      activeSessions.delete(session.id)
      updateSession(db, session.id, { pid: null })
      expireSessionPermissions(db, session.id)
      sessionLogger.warn('Claude tmux session ended')
      options?.onExit?.(null)
    }
  }, 5000)

  exitPollers.set(session.id, pollInterval)
}

const exitPollers = new Map<string, ReturnType<typeof setInterval>>()

// --- Permission-mode runtime control ---
//
// Claude's TUI cycles permission modes on Shift+Tab. There is no IPC, and
// the session JSONL is NOT updated on cycles (only on spawn/resume) — we
// verified empirically that 6 cycles in a row produce no JSONL records.
// So we read the mode from the visible TUI via `tmux capture-pane`.
//
// Markers below were verified against claude 2.1.142. The marker line is at
// the bottom of the pane; absence of any marker means default mode (claude
// only displays "(shift+tab to cycle)" for non-default modes).

const MODE_PANE_MARKERS: Record<Exclude<UserPermissionMode, 'default'>, string> = {
  plan: 'plan mode on',
  acceptEdits: 'accept edits on',
  auto: 'auto mode on',
}

function capturePaneText(tmuxName: string): string | null {
  try {
    return execFileSync('tmux', tmuxArgs('capture-pane', '-t', tmuxName, '-p'), {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

/** Read the current permission mode from the live TUI. Returns null only if
 *  the pane can't be captured (tmux session gone). */
export function readLivePermissionMode(session: Session): UserPermissionMode | null {
  const pane = capturePaneText(tmuxSessionName(session))
  if (pane === null) return null
  const lower = pane.toLowerCase()
  for (const [mode, marker] of Object.entries(MODE_PANE_MARKERS)) {
    if (lower.includes(marker)) return mode as UserPermissionMode
  }
  return 'default'
}

/** Send Shift+Tab to claude. tmux send-keys 'BTab' emits the back-tab key
 *  sequence (\e[Z), which claude's TUI interprets as the mode-cycle key. */
function sendShiftTab(tmuxName: string, logger: Logger): boolean {
  try {
    execFileSync('tmux', tmuxArgs('send-keys', '-t', tmuxName, 'BTab'), {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch (err) {
    logger.warn({ err, tmuxName }, 'send-keys BTab failed')
    return false
  }
}

/** Type one Matrix message into the session's TUI, then press Enter. Used
 *  instead of the relay channel when CMB_INPUT_MODE=tmux. Newlines become
 *  spaces so the first Enter can't submit a partial message.
 *  ponytail: single-line only; add bracketed paste (paste-buffer -p) for multi-line. */
export async function sendTmuxInput(session: Session, text: string): Promise<void> {
  const tmuxName = tmuxSessionName(session)
  const line = text.replace(/\r?\n/g, ' ').trim()
  if (!line) return
  execFileSync('tmux', tmuxArgs('send-keys', '-t', tmuxName, '-l', '--', line), {
    encoding: 'utf-8',
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Enter sent instantly after the text gets swallowed while the TUI is redrawing.
  // ponytail: fixed delay, no submit verification; poll the pane if it still drops.
  await new Promise(r => setTimeout(r, 200))
  execFileSync('tmux', tmuxArgs('send-keys', '-t', tmuxName, 'Enter'), {
    encoding: 'utf-8',
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Text of Claude's pending approval dialog (the "Do you want to proceed?" menu), or null.
 *  ponytail: matches the TUI's menu by its "Esc to cancel" footer + numbered "❯ 1."; may drift across claude versions. */
export function readPermissionPrompt(session: Session): string | null {
  const pane = capturePaneText(tmuxSessionName(session))
  if (!pane) return null
  const lines = pane.split('\n')
  let end = lines.length - 1
  while (end >= 0 && !lines[end]!.includes('Esc to cancel')) end--
  if (end < 0 || !lines.slice(Math.max(0, end - 8), end).some(l => /❯\s*1\./.test(l))) return null
  return lines.slice(Math.max(0, end - 22), end + 1).join('\n').trim()
}

/** Answer that dialog: Enter takes the default "Yes", Escape cancels. */
export function answerPermissionPrompt(session: Session, allow: boolean): void {
  execFileSync('tmux', tmuxArgs('send-keys', '-t', tmuxSessionName(session), allow ? 'Enter' : 'Escape'), {
    encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Cycle the TUI's permission mode (via Shift+Tab) until capture-pane shows
 *  `target`. The TUI updates within ~100 ms of the keystroke, so we poll
 *  briefly after each press and break as soon as the mode changes. */
export async function cycleToPermissionMode(
  session: Session,
  target: UserPermissionMode,
  logger: Logger,
): Promise<{ ok: boolean; mode: UserPermissionMode | null; reason?: string }> {
  const tmuxName = tmuxSessionName(session)
  const start = readLivePermissionMode(session)
  if (start === null) {
    return { ok: false, mode: null, reason: 'could not capture tmux pane' }
  }
  if (start === target) return { ok: true, mode: target }

  // Safety cap — claude has 4 known cycle modes; 6 leaves room for one extra.
  const maxAttempts = 6
  // After each Shift+Tab, poll the pane up to maxWaitMs every pollMs and
  // break early as soon as the mode changes.
  const maxWaitMs = 1500
  const pollMs = 100
  const seen: (UserPermissionMode | null)[] = [start]
  let last: UserPermissionMode | null = start
  for (let i = 0; i < maxAttempts; i++) {
    if (!sendShiftTab(tmuxName, logger)) {
      return { ok: false, mode: readLivePermissionMode(session), reason: 'send-keys failed' }
    }
    const deadline = Date.now() + maxWaitMs
    let observed: UserPermissionMode | null = last
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs))
      observed = readLivePermissionMode(session)
      if (observed !== null && observed !== last) break
    }
    seen.push(observed)
    last = observed
    if (observed === target) {
      logger.debug(
        { session: session.name, from: start, to: observed, cycles: i + 1 },
        'Mode cycled',
      )
      return { ok: true, mode: target }
    }
  }

  logger.warn(
    { session: session.name, target, seen },
    'cycleToPermissionMode exhausted attempts',
  )
  return {
    ok: false,
    mode: last,
    reason: `cycled ${maxAttempts}× without reaching ${target} (saw: ${seen.join(' → ')})`,
  }
}

export async function killClaude(
  session: Session,
  logger: Logger,
): Promise<void> {
  const tmuxName = tmuxSessionName(session)
  const sessionLogger = logger.child({ session: session.name, tmux: tmuxName })

  const poller = exitPollers.get(session.id)
  if (poller) {
    clearInterval(poller)
    exitPollers.delete(session.id)
  }

  // Send Ctrl+C to Claude first (graceful)
  try {
    execFileSync('tmux', tmuxArgs('send-keys', '-t', tmuxName, 'C-c', ''), {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessionLogger.info('Sent Ctrl+C to Claude')
  } catch {
    // Session might already be gone
  }

  await new Promise(r => setTimeout(r, 3000))

  try {
    execFileSync('tmux', tmuxArgs('kill-session', '-t', tmuxName), {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sessionLogger.info('Killed tmux session')
  } catch {
    // Already gone
  }

  activeSessions.delete(session.id)
}

export async function killAllProcesses(logger: Logger): Promise<void> {
  // Stop all exit pollers
  for (const [id, poller] of exitPollers) {
    clearInterval(poller)
    exitPollers.delete(id)
  }

  // Kill our entire tmux server — clean and thorough, since we have
  // a dedicated socket and nothing else lives there.
  killTmuxServer(logger)

  activeSessions.clear()
}
