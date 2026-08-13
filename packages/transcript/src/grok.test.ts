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

    // Grok's own injected turns wear role 'user'. The system_reminder one is
    // written at session creation, so leaving it in would make an untouched
    // session open on a skill listing posing as the user's first message.
    for (const reason of ['system_reminder', 'project_instructions', 'task_completed']) {
      expect(
        grokRecordToItems({
          type: 'user',
          id: `synthetic-${reason}`,
          synthetic_reason: reason,
          content: [{ type: 'text', text: '<system-reminder>skills…</system-reminder>' }],
        }),
      ).toEqual([])
    }

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
        toolPaths: ['src/app.ts'],
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

  it('recovers Grok assistant.tool_calls and names the command or file', () => {
    const items = grokRecordToItems({
      type: 'assistant',
      content: "I'll check what's already on the board.",
      tool_calls: [
        {
          id: 'call-1d7d7f3e-a2af-456b-abac-f2dc5d8f6e79-0',
          name: 'run_terminal_command',
          arguments:
            '{"command":"podium issue prime","description":"Prime current issue and ready work"}',
        },
      ],
    })
    expect(items).toEqual([
      {
        id: expect.stringMatching(/^grok-assistant-/),
        role: 'assistant',
        text: "I'll check what's already on the board.",
      },
      {
        id: 'call-1d7d7f3e-a2af-456b-abac-f2dc5d8f6e79-0',
        role: 'tool',
        text: '',
        toolName: 'Bash',
        toolInput: 'podium issue prime',
        toolTitle: 'Prime current issue and ready work',
        toolUseId: 'call-1d7d7f3e-a2af-456b-abac-f2dc5d8f6e79-0',
      },
    ])
  })

  it('maps Grok file, search, and edit calls onto the shared display names', () => {
    const items = grokRecordToItems({
      type: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-read',
          name: 'read_file',
          arguments: '{"target_file":"/repo/apps/web/src/ChatView.tsx","limit":80}',
        },
        {
          id: 'call-grep',
          name: 'grep',
          arguments: '{"pattern":"Ran a tool","glob":"*.{ts,tsx}"}',
        },
        {
          id: 'call-edit',
          name: 'search_replace',
          arguments: '{"file_path":"/repo/packages/transcript/src/grok.ts","old_string":"a","new_string":"b"}',
        },
      ],
    })
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({
      id: 'call-read',
      role: 'tool',
      text: '',
      toolName: 'Read',
      toolInput: '/repo/apps/web/src/ChatView.tsx',
      toolPaths: ['/repo/apps/web/src/ChatView.tsx'],
      toolUseId: 'call-read',
    })
    expect(items[1]).toEqual({
      id: 'call-grep',
      role: 'tool',
      text: '',
      toolName: 'Grep',
      toolInput: 'Ran a tool',
      toolUseId: 'call-grep',
    })
    expect(items[2]).toMatchObject({
      id: 'call-edit',
      role: 'tool',
      text: '',
      toolName: 'Edit',
      toolInput: '/repo/packages/transcript/src/grok.ts',
      toolPaths: ['/repo/packages/transcript/src/grok.ts'],
      toolUseId: 'call-edit',
    })
    expect(JSON.parse(items[2]?.toolInputJson ?? '{}')).toMatchObject({
      kind: 'file-edit',
      path: '/repo/packages/transcript/src/grok.ts',
      mode: 'replace',
    })
  })

  it('pairs a later tool_result to the recovered call by tool_call_id', () => {
    const call = grokRecordToItems({
      type: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-shell',
          name: 'run_terminal_command',
          arguments: '{"command":"podium issue dep-add --help","description":"Show dep-add help"}',
        },
      ],
    })
    const result = grokRecordToItems({
      type: 'tool_result',
      tool_call_id: 'call-shell',
      content: 'exit: 0\nUsage: podium issue dep-add\n'.repeat(12),
    })
    expect(call[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: 'podium issue dep-add --help',
      toolUseId: 'call-shell',
    })
    expect(result[0]).toMatchObject({
      role: 'tool',
      toolUseId: 'call-shell',
      toolResult: expect.stringMatching(/^exit: 0\n/),
    })
    expect(result[0]?.toolName).toBeUndefined()
  })

  it('carries AskUserQuestion structure so the chat can render the card', () => {
    const items = grokRecordToItems({
      type: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-ask',
          name: 'ask_user_question',
          arguments: JSON.stringify({
            questions: [
              {
                question: 'Reload the running server?',
                options: [
                  { label: 'Reload', description: 'Pick up the parser fix' },
                  { label: 'Wait', description: 'Leave it until later' },
                ],
              },
            ],
          }),
        },
      ],
    })
    expect(items[0]).toMatchObject({
      toolName: 'AskUserQuestion',
      toolInput: 'Reload the running server?',
      toolUseId: 'call-ask',
    })
    expect(JSON.parse(items[0]?.toolInputJson ?? '{}').questions[0].options).toHaveLength(2)
  })

  it('does not double-emit a call that already arrived as a content block', () => {
    const items = grokRecordToItems({
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/app.ts' } }],
      tool_calls: [
        {
          id: 'tool-1',
          name: 'read_file',
          arguments: '{"target_file":"src/app.ts"}',
        },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ toolName: 'Read', toolUseId: 'tool-1' })
  })
})
