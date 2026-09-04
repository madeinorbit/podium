import { describe, expect, it } from 'vitest'
import { piRecordToItems, piRuntime } from './pi'

const ts = '2026-09-02T09:48:47.074Z'
const entry = (id: string, message: Record<string, unknown>) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: ts,
  message,
})

describe('piRecordToItems', () => {
  it('ignores the header and runtime entries', () => {
    expect(piRecordToItems({ type: 'session', version: 3, id: 'x' })).toEqual([])
    expect(piRecordToItems({ type: 'model_change', provider: 'fake', modelId: 'm' })).toEqual([])
    expect(piRecordToItems({ type: 'thinking_level_change', thinkingLevel: 'off' })).toEqual([])
    expect(piRecordToItems(null)).toEqual([])
  })

  it('maps a user entry', () => {
    expect(
      piRecordToItems(entry('9d671487', { role: 'user', content: [{ type: 'text', text: 'hi' }] })),
    ).toEqual([{ id: '9d671487', role: 'user', text: 'hi', ts }])
  })

  it('splits an assistant tool-call entry into a tool item, and marks the final answer', () => {
    expect(
      piRecordToItems(
        entry('57f31578', {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me look' },
            { type: 'text', text: 'Listing first.' },
            {
              type: 'toolCall',
              id: 'call_1',
              name: 'bash',
              arguments: { command: 'echo hello-from-tool' },
            },
          ],
          stopReason: 'toolUse',
        }),
      ),
    ).toEqual([
      { id: '57f31578', role: 'assistant', text: 'Listing first.', ts },
      {
        id: 'call_1',
        role: 'tool',
        text: '',
        toolName: 'bash',
        toolInput: 'echo hello-from-tool',
        toolUseId: 'call_1',
        ts,
      },
    ])
    expect(
      piRecordToItems(
        entry('9442e01a', {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reply #2: I saw 1 user message(s). ' }],
          stopReason: 'stop',
        }),
      ),
    ).toEqual([
      {
        id: '9442e01a',
        role: 'assistant',
        text: 'Reply #2: I saw 1 user message(s).',
        answer: true,
        ts,
      },
    ])
  })

  it('pairs a toolResult with its call and surfaces tool errors', () => {
    expect(
      piRecordToItems(
        entry('ab5a0a4e', {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'hello-from-tool\n' }],
          isError: false,
        }),
      ),
    ).toEqual([
      {
        id: 'ab5a0a4e',
        role: 'tool',
        text: '',
        toolResult: 'hello-from-tool',
        toolUseId: 'call_1',
        ts,
      },
    ])
    expect(
      piRecordToItems(
        entry('e', { role: 'toolResult', toolCallId: 'c', content: [], isError: true }),
      ),
    ).toEqual([{ id: 'e', role: 'tool', text: '', toolResult: '(tool error)', toolUseId: 'c', ts }])
  })

  it('renders a provider error as the assistant turn that failed', () => {
    expect(
      piRecordToItems(
        entry('ee808dae', {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '500: {"message":"simulated provider outage"}',
        }),
      ),
    ).toEqual([
      {
        id: 'ee808dae',
        role: 'assistant',
        text: 'Error: 500: {"message":"simulated provider outage"}',
        ts,
      },
    ])
  })

  it('shows bash executions as a call/result pair and summaries as recaps', () => {
    expect(
      piRecordToItems(
        entry('b1', { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0 }),
      ),
    ).toEqual([
      {
        id: 'b1',
        role: 'tool',
        text: '',
        toolName: 'bash',
        toolInput: 'git status',
        toolUseId: 'b1',
        ts,
      },
      { id: 'b1:result', role: 'tool', text: '', toolResult: 'clean', toolUseId: 'b1', ts },
    ])
    expect(
      piRecordToItems(
        entry('c1', { role: 'compactionSummary', summary: 'Earlier: …', tokensBefore: 9 }),
      ),
    ).toEqual([{ id: 'c1', role: 'system', text: 'Earlier: …', systemKind: 'recap', ts }])
    expect(
      piRecordToItems(entry('x', { role: 'custom', display: false, content: 'hidden' })),
    ).toEqual([])
  })
})

describe('piRuntime', () => {
  it('reads model and thinking level off their change entries and assistant messages', () => {
    expect(piRuntime({ type: 'model_change', provider: 'fake', modelId: 'fake-model' })).toEqual({
      model: 'fake/fake-model',
    })
    expect(piRuntime({ type: 'thinking_level_change', thinkingLevel: 'high' })).toEqual({
      effort: 'high',
    })
    expect(
      piRuntime(
        entry('a', { role: 'assistant', provider: 'openai', model: 'gpt-5.5', content: [] }),
      ),
    ).toEqual({ model: 'openai/gpt-5.5' })
    expect(piRuntime(entry('u', { role: 'user', content: 'x' }))).toEqual({})
  })
})
