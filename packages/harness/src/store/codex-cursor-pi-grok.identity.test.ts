import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { codexRecordToItems } from './codex'
import { cursorRecordToItems } from './cursor'
import { stampCursors } from './cursor-codec'
import { grokRecordToItems } from './grok'
import { piRecordToItems } from './pi'

const content = [{ type: 'text', text: 'hello' }]
const tool = { type: 'tool_use', name: 'Read', input: { file_path: 'hello' } }
const result = { type: 'tool_result', content: 'hello' }
const codex = (payload: object, type = 'response_item') => ({ type, payload })
const pi = (message: object) => ({ type: 'message', message })

const cases: [string, (record: unknown) => TranscriptItem[], object[]][] = [
  [
    'codex',
    codexRecordToItems,
    [
      codex({ type: 'turn_aborted' }, 'event_msg'),
      codex({ type: 'user_message', message: 'hello' }, 'event_msg'),
      codex({ type: 'item_completed', item: { type: 'UserMessage', content } }, 'event_msg'),
      codex({ type: 'message', role: 'assistant', content }),
      codex({ type: 'function_call', name: 'Read', arguments: { path: 'hello' } }),
      codex({ type: 'custom_tool_call', name: 'Read', input: 'hello' }),
      codex({ type: 'function_call_output', output: 'hello' }),
      codex({ type: 'custom_tool_call_output', output: 'hello' }),
    ],
  ],
  [
    'cursor',
    cursorRecordToItems,
    [
      { role: 'user', message: { content } },
      { role: 'assistant', message: { content: [...content, tool, tool, result, result] } },
    ],
  ],
  [
    'pi',
    piRecordToItems,
    [
      pi({ role: 'user', content }),
      pi({
        role: 'assistant',
        content: [
          ...content,
          { type: 'toolCall', name: 'Read', arguments: { path: 'hello' } },
          { type: 'toolCall', name: 'Read' },
        ],
      }),
      pi({ role: 'assistant', stopReason: 'error', errorMessage: 'hello' }),
      pi({ role: 'toolResult', content }),
      pi({ role: 'bashExecution', command: 'hello', output: 'hello' }),
      pi({ role: 'custom', display: true, content }),
      pi({ role: 'compactionSummary', summary: 'hello' }),
      pi({ role: 'branchSummary', summary: 'hello' }),
    ],
  ],
  [
    'grok',
    grokRecordToItems,
    [
      { role: 'user', content },
      { role: 'assistant', content: [...content, tool, tool, result, result] },
      { role: 'assistant', content, tool_calls: [tool, tool] },
      tool,
      result,
    ],
  ],
]

for (const [name, mapper, records] of cases) {
  describe(`${name} position identity`, () => {
    for (const [index, record] of records.entries()) {
      const bytes = JSON.stringify(record)
      const parse = (value = bytes, offset = 42) =>
        stampCursors(mapper(JSON.parse(value)), 'fixture-file', offset, null)
      it(`record ${index}: deterministic, distinct at another position, stable during growth`, () => {
        const first = parse()
        expect(first.length).toBeGreaterThan(0)
        expect(parse()).toEqual(first)
        expect(new Set(first.map((item) => item.id)).size).toBe(first.length)
        for (const item of first) expect(item.id).toBe(item.cursor)
        const ids = first.map((item) => item.id)
        expect(parse(bytes, 900).every((item) => !ids.includes(item.id))).toBe(true)
        expect(parse(bytes.replaceAll('hello', 'hello world')).map((item) => item.id)).toEqual(ids)
      })
    }
  })
}

const providerCases: [string, (record: unknown) => TranscriptItem[], object, string[]][] = [
  [
    'codex assistant',
    codexRecordToItems,
    codex({ type: 'message', role: 'assistant', id: 'msg_1', content }),
    ['msg_1'],
  ],
  [
    'codex user',
    codexRecordToItems,
    codex({ type: 'user_message', id: 'usr_1', message: 'hello' }, 'event_msg'),
    ['usr_1'],
  ],
  [
    'codex completed user',
    codexRecordToItems,
    codex(
      { type: 'item_completed', item: { type: 'UserMessage', id: 'usr_1', content } },
      'event_msg',
    ),
    ['usr_1'],
  ],
  [
    'codex interrupt',
    codexRecordToItems,
    codex({ type: 'turn_aborted', id: 'abort_1' }, 'event_msg'),
    ['abort_1'],
  ],
  ...['function_call', 'custom_tool_call'].map((type): (typeof providerCases)[number] => [
    'codex call',
    codexRecordToItems,
    codex({ type, call_id: 'call_1', id: 'other', name: 'Read', input: 'hello' }),
    ['call_1'],
  ]),
  ...['function_call_output', 'custom_tool_call_output'].map(
    (type): (typeof providerCases)[number] => [
      'codex result',
      codexRecordToItems,
      codex({ type, call_id: 'call_1', output: 'hello' }),
      ['call_1:out'],
    ],
  ),
  [
    'cursor blocks',
    cursorRecordToItems,
    {
      id: 'entry',
      role: 'assistant',
      message: {
        content: [
          ...content,
          { ...tool, id: 'call' },
          { ...result, tool_use_id: 'call' },
          tool,
          tool,
        ],
      },
    },
    ['entry', 'call', 'call:out', 'entry:3', 'entry:4'],
  ],
  [
    'pi blocks',
    piRecordToItems,
    {
      ...pi({
        role: 'assistant',
        content: [
          ...content,
          { type: 'toolCall', id: 'call', name: 'Read' },
          { type: 'toolCall', name: 'Read' },
        ],
      }),
      id: 'entry',
    },
    ['entry', 'call', 'entry:tool:2'],
  ],
  [
    'pi result',
    piRecordToItems,
    pi({ role: 'toolResult', toolCallId: 'call', content }),
    ['call:out'],
  ],
  [
    'grok blocks',
    grokRecordToItems,
    {
      uuid: 'entry',
      role: 'assistant',
      content: [
        ...content,
        { ...tool, id: 'call' },
        { ...result, tool_call_id: 'call' },
        tool,
        tool,
      ],
    },
    ['entry', 'call', 'call:out', 'entry:3', 'entry:4'],
  ],
  [
    'grok own result',
    grokRecordToItems,
    { ...result, uuid: 'result', tool_call_id: 'call' },
    ['result'],
  ],
  ['grok own tool', grokRecordToItems, { ...tool, uuid: 'call' }, ['call']],
]

for (const [name, mapper, record, expected] of providerCases) {
  it(`${name}: provider IDs survive two parses and text growth`, () => {
    const bytes = JSON.stringify(record)
    const ids = (value: string) =>
      stampCursors(mapper(JSON.parse(value)), 'file', 0, null).map((item) => item.id)
    expect(ids(bytes)).toEqual(expected)
    expect(ids(bytes)).toEqual(expected)
    expect(ids(bytes.replaceAll('hello', 'hello world'))).toEqual(expected)
  })
}
