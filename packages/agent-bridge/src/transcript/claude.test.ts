import { describe, expect, it } from 'vitest'
import { claudeRecordToItems, toolInputPreview } from './claude.js'

describe('claudeRecordToItems', () => {
  it('maps a plain string user prompt', () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-12T10:00:00.000Z',
      message: { role: 'user', content: 'fix the bug' },
    })
    expect(items).toEqual([
      { id: 'u1', role: 'user', ts: '2026-06-12T10:00:00.000Z', text: 'fix the bug' },
    ])
  })

  it('maps an assistant turn with text + tool calls into separate items', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'a1', role: 'assistant', text: 'Let me look.' })
    expect(items[1]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'ls -la',
      toolUseId: 'toolu_1',
    })
  })

  it('maps tool results (user-typed records) to tool items linked by toolUseId', () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    })
    expect(items).toEqual([
      {
        id: 'u2-result',
        role: 'tool',
        ts: undefined,
        text: '',
        toolResult: 'ok',
        toolUseId: 'toolu_1',
      },
    ])
  })

  it('tags image and document blocks on user messages', () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: 'u3',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'see screenshot' },
          { type: 'image', source: { type: 'base64' } },
          { type: 'document', source: { title: 'spec.pdf' } },
        ],
      },
    })
    expect(items[0]).toMatchObject({
      role: 'user',
      text: 'see screenshot',
      tags: [{ kind: 'image' }, { kind: 'file', label: 'spec.pdf' }],
    })
  })

  it('skips sidechain records and bookkeeping types', () => {
    expect(
      claudeRecordToItems({ type: 'assistant', isSidechain: true, message: { content: [] } }),
    ).toEqual([])
    expect(claudeRecordToItems({ type: 'summary', summary: 'x' })).toEqual([])
    expect(claudeRecordToItems('garbage')).toEqual([])
  })

  it('truncates huge tool results', () => {
    const items = claudeRecordToItems({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5000) }],
      },
    })
    expect(items[0]?.toolResult?.length).toBeLessThanOrEqual(2001)
  })
})

describe('toolInputPreview', () => {
  it('prefers the human-meaningful field', () => {
    expect(toolInputPreview({ command: 'bun test', description: 'Run tests' })).toBe('bun test')
    expect(toolInputPreview({ file_path: '/a/b.ts' })).toBe('/a/b.ts')
  })
  it('falls back to compact JSON', () => {
    expect(toolInputPreview({ x: 1 })).toBe('{"x":1}')
  })
})
