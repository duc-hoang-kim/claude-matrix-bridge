import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAssistantText } from '../src/tmux-output.js'

const line = (record: unknown): string => JSON.stringify(record) + '\n'

describe('parseAssistantText', () => {
  it('returns only assistant text blocks, skipping tool use, user turns and sidechains', () => {
    const chunk = Buffer.from(
      line({ type: 'user', message: { content: 'hi' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: ' 42 ' }, { type: 'tool_use', name: 'Bash' }] } }) +
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }),
    )
    const r = parseAssistantText(chunk)
    assert.deepEqual(r.texts, ['42'])
    assert.equal(r.consumed, chunk.length)
  })

  it('leaves a partial trailing line for the next poll', () => {
    const first = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } })
    const r = parseAssistantText(Buffer.from(first + '{"type":"assis'))
    assert.deepEqual(r.texts, ['one'])
    assert.equal(r.consumed, Buffer.byteLength(first))
  })

  it('consumes nothing when there is no newline yet', () => {
    assert.deepEqual(parseAssistantText(Buffer.from('{"type":"assistant"')), { texts: [], consumed: 0 })
  })
})
