import { describe, expect, it } from 'vitest'
import { cursorRecordToItems } from './cursor'

describe('cursorRecordToItems', () => {
  it('normalizes user and assistant messages', () => {
    const items = [
      ...cursorRecordToItems({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] },
      }),
      ...cursorRecordToItems({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hi there.' },
            { type: 'tool_use', name: 'Read', input: { path: '/tmp/x' } },
          ],
        },
      }),
    ]

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'hello' }),
        expect.objectContaining({ role: 'assistant', text: 'Hi there.' }),
        expect.objectContaining({ role: 'tool', toolName: 'Read' }),
      ]),
    )
  })

  it('ignores turn_ended control records', () => {
    expect(cursorRecordToItems({ type: 'turn_ended', status: 'success' })).toEqual([])
  })
})
