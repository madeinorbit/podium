import { readFileSync } from 'node:fs'
import { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import type { OpencodeMessagePartRow } from './transcript.js'
import { opencodePromptTextMatches, opencodeRowsToItems } from './transcript.js'

// Native message/part changes from OpenCode 1.18.33, measured 2026-09-29.
const timeline = readFileSync(
  new URL(
    '../../../../../docs/measurements/pod-4834-receipt-proof/opencode-1.18.33/tui/timeline.jsonl',
    import.meta.url,
  ),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

type NativeRow = {
  id: string
  s: string
  m?: string
  tc: number
  tu: number
  data: Record<string, unknown>
}
const messages = new Map<string, NativeRow>()
const parts = new Map<string, NativeRow>()
for (const entry of timeline) {
  if (entry.kind !== 'db' || entry.change === 'delete') continue
  if (entry.table === 'message') messages.set(entry.row.id, entry.row)
  if (entry.table === 'part') parts.set(entry.row.id, entry.row)
}

function messageFor(messageId: string): NativeRow {
  const message = messages.get(messageId)
  if (!message) throw new Error(`Missing measured message ${messageId}`)
  return message
}

function rowsFor(messageId: string): OpencodeMessagePartRow[] {
  const message = messageFor(messageId)
  return [...parts.values()]
    .filter((part) => part.m === messageId)
    .map((part) => ({
      messageId,
      partId: part.id,
      sessionId: part.s,
      timeCreated: part.tc,
      timeUpdated: part.tu,
      messageData: JSON.stringify(message.data),
      partData: JSON.stringify(part.data),
    }))
}

describe('OpenCode measured prompt entries', () => {
  it('marks a user row with a text part as a prompt entry', () => {
    const rows = rowsFor('msg_0ee0606b7001zBYRfjhAzXvajL')
    expect(rows).toHaveLength(1)
    const [item] = opencodeRowsToItems(rows)
    if (!item) throw new Error('Missing measured user text item')
    expect(item).toMatchObject({ role: 'user', text: 'TUI S1 ALPHA idle', promptEntry: true })
    expect(TranscriptItem.parse(item)).toHaveProperty('promptEntry', true)
    expect(transcriptEchoAcceptCorrelation.accepts(item)).toBe(true)
  })

  it('drops the text-less user message that /compact stores', () => {
    const rows = rowsFor('msg_0ee0901af0011C15u69E6qZrKI')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]?.messageData ?? '')).toHaveProperty('role', 'user')
    expect(JSON.parse(rows[0]?.partData ?? '')).toHaveProperty('type', 'compaction')
    expect(opencodeRowsToItems(rows)).toEqual([])
  })

  it('never turns a crash-left message without a text part into a prompt entry', () => {
    const messageId = 'msg_0ee0d3131001OpA8PjOTkNc0J3'
    expect(messageFor(messageId).data).toHaveProperty('role', 'user')
    const rows = rowsFor(messageId)
    expect(rows).toEqual([])
    expect(opencodeRowsToItems(rows)).toEqual([])
  })

  it('preserves the command expansion as the documented POD-4906 residual', () => {
    // The only measured command marker names the assistant reply, not the user
    // row. It is a live event, absent from the durable event-table evidence.
    const command = timeline.find(
      (entry) => entry.kind === 'sse' && entry.frame.type === 'command.executed',
    ).frame.properties
    expect(command).toMatchObject({ name: 'probe', arguments: 'hello args' })
    expect(
      timeline.filter(
        (entry) => entry.kind === 'db' && entry.row.type?.startsWith('command.executed'),
      ),
    ).toEqual([])
    const reply = messageFor(command.messageID)
    expect(reply.data.role).toBe('assistant')
    const messageId = reply.data.parentID as string
    expect(messageId).toBe('msg_0ee0dddb70010IzMbZxeLd4WbK')
    const rows = rowsFor(messageId)
    expect(JSON.parse(rows[0]?.partData ?? '')).toEqual({
      type: 'text',
      text: 'S9 CMD TEMPLATE expanded with: hello args',
    })
    expect(opencodeRowsToItems(rows)).toEqual([
      expect.objectContaining({ role: 'user', text: 'S9 CMD TEMPLATE expanded with: hello args' }),
    ])
    expect(
      opencodePromptTextMatches('/probe hello args', opencodeRowsToItems(rows)[0]?.text ?? ''),
    ).toBe(false)
  })

  it('keeps HTTP-injected messages real while leaving their unrecorded origin unknown', () => {
    const httpId = 'msg_00b84f23-33fc-4855-ab07-f5e6b4bcd29f'
    const keyboardId = 'msg_0ee0864a1001OfXnzcZMj2qwL0'
    // Same metadata for both sources, apart from creation time. Do not infer
    // origin from the caller-supplied id shape or from words in the message.
    const { time: _httpTime, ...httpData } = messageFor(httpId).data
    const { time: _keyboardTime, ...keyboardData } = messageFor(keyboardId).data
    expect(httpData).toEqual(keyboardData)
    const [http] = opencodeRowsToItems(rowsFor(httpId))
    const [keyboard] = opencodeRowsToItems(rowsFor(keyboardId))
    expect(http).toMatchObject({ role: 'user', text: 'S9a HTTP second', promptEntry: true })
    expect(keyboard).toMatchObject({
      role: 'user',
      text: 'TUI S9a KEYBOARD first',
      promptEntry: true,
    })
    expect(http).not.toHaveProperty('promptOrigin')
    expect(keyboard).not.toHaveProperty('promptOrigin')
  })
})
