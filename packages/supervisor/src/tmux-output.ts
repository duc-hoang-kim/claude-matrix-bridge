import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { jsonlPathFor, parseJsonl } from './replay.js'
import type { Session } from './types.js'

// Byte offset into each session's JSONL. Armed when a Matrix message is typed
// into the pane; dropped once the session leaves 'active'.
const cursors = new Map<string, number>()

/** Call right before typing a Matrix message into the pane: output written after
 *  this point is the reply. No-op if already armed, so a second message doesn't
 *  skip output that is still being written. */
export function armTmuxOutput(session: Session): void {
  if (cursors.has(session.id)) return
  const path = jsonlPathFor(session.id, session.working_directory)
  cursors.set(session.id, existsSync(path) ? statSync(path).size : 0)
}

/** Assistant text blocks from the complete lines in `chunk`. `consumed` is the
 *  byte count through the last newline; a partial trailing line waits for the
 *  next poll. */
export function parseAssistantText(chunk: Buffer): { texts: string[]; consumed: number } {
  const last = chunk.lastIndexOf(0x0a)
  if (last < 0) return { texts: [], consumed: 0 }
  const texts: string[] = []
  for (const r of parseJsonl(chunk.subarray(0, last + 1).toString('utf8'))) {
    if (r.type !== 'assistant' || r.isSidechain) continue
    const content = r.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) texts.push(b.text.trim())
    }
  }
  return { texts, consumed: last + 1 }
}

/** Assistant text written since the last poll. Disarms when the session is no longer active. */
export function pollTmuxOutput(session: Session): string[] {
  if (session.status !== 'active') {
    cursors.delete(session.id)
    return []
  }
  const cursor = cursors.get(session.id)
  if (cursor === undefined) return []
  const path = jsonlPathFor(session.id, session.working_directory)
  if (!existsSync(path)) return []
  const size = statSync(path).size
  if (size < cursor) {
    // Transcript shrank (replaced or truncated): resync to its end, don't re-post.
    cursors.set(session.id, size)
    return []
  }
  if (size === cursor) return []
  const buf = Buffer.alloc(size - cursor)
  const fd = openSync(path, 'r')
  let read: number
  try {
    read = readSync(fd, buf, 0, buf.length, cursor)
  } finally {
    closeSync(fd)
  }
  const { texts, consumed } = parseAssistantText(buf.subarray(0, read))
  cursors.set(session.id, cursor + consumed)
  return texts
}
