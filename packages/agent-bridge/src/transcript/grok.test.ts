import { describe, expect, it } from 'vitest'
import { grokRecordToItems } from './grok'

describe('grokRecordToItems', () => {
  it('maps Grok chat history user and assistant records to transcript items', () => {
    expect(
      grokRecordToItems({
        type: 'user',
        timestamp: '2026-06-15T10:00:00.000Z',
        content: [{ type: 'text', text: 'hello' }],
      }),
    ).toEqual([
      {
        id: expect.stringMatching(/^grok-user-/),
        role: 'user',
        ts: '2026-06-15T10:00:00.000Z',
        text: 'hello',
      },
    ])

    expect(
      grokRecordToItems({
        type: 'assistant',
        id: 'assistant-1',
        timestamp: '2026-06-15T10:00:01.000Z',
        content: 'hi there',
      }),
    ).toEqual([
      {
        id: 'assistant-1',
        role: 'assistant',
        ts: '2026-06-15T10:00:01.000Z',
        text: 'hi there',
      },
    ])
  })

  it('filters Grok internal context while preserving attachment tags and tool activity', () => {
    expect(
      grokRecordToItems({
        type: 'reasoning',
        encrypted_content: 'opaque',
        status: 'complete',
      }),
    ).toEqual([])

    expect(grokRecordToItems({ type: 'system', content: 'system prompt' })).toEqual([])

    expect(
      grokRecordToItems({
        type: 'user',
        id: 'internal-context',
        content: '<user_info>runtime details</user_info>\n<rules>hidden rules</rules>',
      }),
    ).toEqual([])

    expect(
      grokRecordToItems({
        type: 'user',
        id: 'tagged-query',
        content: '<user_query>Reply exactly PODIUM_GROK_CHAT_OK.</user_query>',
      }),
    ).toEqual([
      {
        id: 'tagged-query',
        role: 'user',
        text: 'Reply exactly PODIUM_GROK_CHAT_OK.',
      },
    ])

    expect(
      grokRecordToItems({
        type: 'user',
        id: 'user-2',
        content: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', source: { title: 'screenshot.png' } },
          { type: 'document', source: { title: 'notes.md' } },
        ],
      }),
    ).toEqual([
      {
        id: 'user-2',
        role: 'user',
        text: 'inspect this',
        tags: [{ kind: 'image' }, { kind: 'file', label: 'notes.md' }],
      },
    ])

    expect(
      grokRecordToItems({
        type: 'assistant',
        id: 'assistant-2',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/app.ts' } },
        ],
      }),
    ).toEqual([
      { id: 'assistant-2', role: 'assistant', text: 'checking' },
      {
        id: 'tool-1',
        role: 'tool',
        text: '',
        toolName: 'Read',
        toolInput: 'src/app.ts',
        toolUseId: 'tool-1',
      },
    ])

    expect(
      grokRecordToItems({
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [{ type: 'text', text: 'file contents' }],
      }),
    ).toEqual([
      {
        id: expect.stringMatching(/^grok-tool-result-/),
        role: 'tool',
        text: '',
        toolResult: 'file contents',
        toolUseId: 'tool-1',
      },
    ])
  })
})
