import { describe, expect, it } from 'vitest'
import type { OpencodeMessagePartRow } from './opencode'
import { classifyOpencodeIdleText, opencodePartToItems } from './opencode'

function row(
  overrides: Partial<OpencodeMessagePartRow> & {
    messageData: string
    partData: string
  },
): OpencodeMessagePartRow {
  return {
    messageId: 'msg-1',
    partId: 'prt-1',
    sessionId: 'ses-1',
    timeCreated: 1_700_000_000_000,
    timeUpdated: 1_700_000_000_100,
    ...overrides,
  }
}

describe('opencodePartToItems', () => {
  it('maps user text parts to user transcript items', () => {
    const items = opencodePartToItems(
      row({
        messageData: JSON.stringify({ role: 'user' }),
        partData: JSON.stringify({ type: 'text', text: 'fix the chat view' }),
      }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user', text: 'fix the chat view' })
  })

  it('maps assistant text parts to assistant transcript items', () => {
    const items = opencodePartToItems(
      row({
        messageData: JSON.stringify({ role: 'assistant' }),
        partData: JSON.stringify({ type: 'text', text: 'On it.' }),
      }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'assistant', text: 'On it.' })
  })

  it('maps tool parts to tool call and result items', () => {
    const items = opencodePartToItems(
      row({
        partId: 'prt-tool',
        messageData: JSON.stringify({ role: 'assistant' }),
        partData: JSON.stringify({
          type: 'tool',
          tool: 'read',
          callID: 'call-1',
          state: { input: { filePath: '/tmp/x' }, output: 'hello' },
        }),
      }),
    )
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ role: 'tool', toolName: 'read', toolUseId: 'call-1' })
    expect(items[1]).toMatchObject({ role: 'tool', toolResult: 'hello', toolUseId: 'call-1' })
  })

  it('skips reasoning and step markers', () => {
    expect(
      opencodePartToItems(
        row({
          messageData: JSON.stringify({ role: 'assistant' }),
          partData: JSON.stringify({ type: 'reasoning', text: 'thinking' }),
        }),
      ),
    ).toEqual([])
  })
})

describe('classifyOpencodeIdleText', () => {
  it('classifies trailing questions as needs answer', () => {
    expect(classifyOpencodeIdleText('Should I continue?')).toMatchObject({ kind: 'question' })
  })

  it('classifies statements as done', () => {
    expect(classifyOpencodeIdleText('All set.')).toMatchObject({ kind: 'done' })
  })
})
