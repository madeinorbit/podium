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
