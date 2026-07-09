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
    expect(items[0]).toMatchObject({ role: 'tool', toolName: 'exec_command', toolUseId: 'call_1' })
    expect(items[0]?.toolInput).toContain('ls -la')
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
