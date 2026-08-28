import { describe, expect, it } from 'vitest'
import { codexRecordToItems } from './codex'

const env = (type: string, payload: unknown, ts = '2026-06-16T16:11:00.000Z') => ({
  timestamp: ts,
  type,
  payload,
})

describe('codexRecordToItems', () => {
  it('takes the clean user prompt from event_msg.user_message', () => {
    const items = codexRecordToItems(
      env('event_msg', { type: 'user_message', message: 'fix the chat view' }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user', text: 'fix the chat view' })
  })

  it('surfaces turn_aborted as the shared interrupt event', () => {
    expect(codexRecordToItems(env('event_msg', { type: 'turn_aborted' }))).toEqual([
      {
        id: expect.any(String),
        role: 'user',
        ts: '2026-06-16T16:11:00.000Z',
        text: 'Conversation interrupted',
        event: 'interrupt',
      },
    ])
  })

  it('takes the clean user prompt from event_msg.item_completed UserMessage', () => {
    const items = codexRecordToItems(
      env('event_msg', {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          id: 'user-message-1',
          content: [{ type: 'text', text: 'please quickly push the pending commits' }],
        },
      }),
    )
    expect(items).toEqual([
      {
        id: 'user-message-1',
        role: 'user',
        ts: '2026-06-16T16:11:00.000Z',
        text: 'please quickly push the pending commits',
      },
    ])
  })

  it('skips item_completed events that are not user messages', () => {
    expect(
      codexRecordToItems(
        env('event_msg', {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            content: [{ type: 'text', text: 'internal duplicate' }],
          },
        }),
      ),
    ).toEqual([])
  })

  it('keeps a current-format opening prompt before the assistant turn', () => {
    const records = [
      env('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'please quickly push the pending commits' }],
      }),
      env('event_msg', {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          id: 'opening-prompt',
          content: [{ type: 'text', text: 'please quickly push the pending commits' }],
        },
      }),
      env('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will push the pending commits.' }],
      }),
    ]

    expect(records.flatMap(codexRecordToItems).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'please quickly push the pending commits' },
      { role: 'assistant', text: 'I will push the pending commits.' },
    ])
  })

  it('skips the injected response_item user/developer preamble', () => {
    expect(
      codexRecordToItems(
        env('response_item', {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '<permissions instructions> …' }],
        }),
      ),
    ).toEqual([])
    expect(
      codexRecordToItems(
        env('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md …' }],
        }),
      ),
    ).toEqual([])
  })

  it('emits assistant text from response_item.message(assistant)', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }),
    )
    expect(items).toEqual([expect.objectContaining({ role: 'assistant', text: 'Done.' })])
  })

  it('marks only Codex final-answer messages as answers', () => {
    const commentary = codexRecordToItems(
      env('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'I am checking the parser.' }],
      }),
    )
    const answer = codexRecordToItems(
      env('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'The parser is fixed.' }],
      }),
    )

    expect(commentary[0]).not.toHaveProperty('answer')
    expect(answer[0]).toMatchObject({ answer: true, text: 'The parser is fixed.' })
  })

  it('maps function_call to a tool item keyed by call_id', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_1',
        arguments: '{"cmd":"ls -la"}',
      }),
    )
    expect(items[0]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'ls -la',
      toolUseId: 'call_1',
    })
  })

  it('maps request_user_input to the structured question card shape', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call_question',
        arguments: JSON.stringify({
          questions: [
            {
              id: 'main_commit',
              header: 'Main commit',
              question: 'What should happen to main?',
              options: [
                {
                  label: 'Leave main as is (Recommended)',
                  description: 'Duplicate but harmless.',
                },
                { label: 'Rewind main by one commit', description: 'Move the shared branch.' },
              ],
            },
          ],
        }),
      }),
    )

    expect(items[0]).toMatchObject({
      role: 'tool',
      toolName: 'AskUserQuestion',
      toolInput: 'What should happen to main?',
      toolUseId: 'call_question',
    })
    expect(JSON.parse(items[0]?.toolInputJson ?? '{}').questions[0]).toMatchObject({
      header: 'Main commit',
      options: [
        { label: 'Leave main as is (Recommended)' },
        { label: 'Rewind main by one commit' },
      ],
    })
  })

  it('unwraps unified exec calls into the command the reader cares about', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_exec',
        input:
          'const r = await tools.exec_command({"cmd":"bun run test:web","workdir":"/repo"}); text(r.output);',
      }),
    )

    expect(items[0]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'bun run test:web',
      toolUseId: 'call_exec',
    })
  })

  it('unwraps current exec calls whose generated object uses JavaScript keys', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_exec_js_object',
        input:
          'const r = await tools.exec_command({cmd:"rg -n \\"Bash|exec\\" packages/transcript\\nsed -n \'1,80p\' package.json",workdir:"/repo",yield_time_ms:10000}); text(r.output);',
      }),
    )

    expect(items[0]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'rg -n "Bash|exec" packages/transcript\nsed -n \'1,80p\' package.json',
      toolUseId: 'call_exec_js_object',
    })
  })

  it('does not read a fake cmd field from inside a generated command string', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        input:
          'const r = await tools.exec_command({workdir:"/repo",cmd:"printf \'{cmd:\\\"fake\\\"}\'"}); text(r.output);',
      }),
    )

    expect(items[0]).toMatchObject({ toolName: 'Bash', toolInput: 'printf \'{cmd:"fake"}\'' })
  })

  it('does not mistake tool names inside a command string for nested calls', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        input:
          'const r = await tools.exec_command({"cmd":"rg -n \\"tools.apply_patch(\\" packages"}); text(r.output);',
      }),
    )

    expect(items[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: 'rg -n "tools.apply_patch(" packages',
    })
  })

  it('names a wrapped patch by the files it changes', () => {
    const patch =
      '*** Begin Patch\n*** Update File: packages/transcript/src/codex.ts\n@@\n-old\n+new\n*** End Patch'
    const items = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_patch',
        input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
      }),
    )

    expect(items[0]).toMatchObject({
      role: 'tool',
      toolName: 'Edit',
      toolInput: 'packages/transcript/src/codex.ts',
      toolPaths: ['packages/transcript/src/codex.ts'],
    })
    expect(JSON.parse(items[0]?.toolInputJson ?? '{}')).toMatchObject({
      kind: 'file-edit',
      path: 'packages/transcript/src/codex.ts',
      mode: 'patch',
      added: 1,
      removed: 1,
    })
  })

  it('describes command polling and multi-tool orchestration without saying exec', () => {
    const poll = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        input:
          'let { output } = await tools.write_stdin({"session_id":6663,"chars":""}); text(output);',
      }),
    )
    const parallel = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        input:
          'const rs = await Promise.all([tools.exec_command({"cmd":"bun test"}), tools.exec_command({"cmd":"bun run typecheck"})]); text(rs.length);',
      }),
    )

    expect(poll[0]).toMatchObject({ toolName: 'Bash', toolInput: 'command session 6663' })
    expect(parallel[0]).toMatchObject({ toolName: 'Workflow', toolTitle: '2 commands' })
  })

  it('keeps unrecognized exec scripts quiet without exposing their JavaScript', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'for (;;) { break }',
      }),
    )

    expect(items[0]).toMatchObject({ toolName: 'Workflow', toolTitle: 'automation' })
    expect(items[0]?.toolInput).toBeUndefined()
  })

  it('maps function_call_output to a tool-result item paired by call_id', () => {
    const items = codexRecordToItems(
      env('response_item', {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'total 0\n',
      }),
    )
    expect(items[0]).toMatchObject({ role: 'tool', toolUseId: 'call_1', toolResult: 'total 0' })
  })

  it('skips reasoning, session_meta, turn_context, and other event_msg', () => {
    expect(
      codexRecordToItems(
        env('response_item', { type: 'reasoning', encrypted_content: 'x', summary: [] }),
      ),
    ).toEqual([])
    expect(codexRecordToItems(env('session_meta', { id: 'u', cwd: '/x' }))).toEqual([])
    expect(codexRecordToItems(env('turn_context', {}))).toEqual([])
    expect(codexRecordToItems(env('event_msg', { type: 'task_started', turn_id: 't1' }))).toEqual(
      [],
    )
  })
})
