import { describe, expect, it } from 'vitest'
import { SYNTHESIZED_ITEM_ID_PREFIX } from '../../store/cursor-codec.js'
import { grokRecordEndsTurn, grokRecordToItems } from './transcript.js'

// One `updates.jsonl` line as Grok 1.0.44 writes it (shapes from real sessions
// and docs/measurements/pod-4834-receipt-proof/grok-tui-1.0.44/).
const SESSION = '01a0edee-690d-73c0-bba4-6a60e8bc0ebb'
let event = 0
function line(update: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  event += 1
  return {
    timestamp: 1790698265,
    method:
      typeof update.sessionUpdate === 'string' && update.sessionUpdate.endsWith('_chunk')
        ? 'session/update'
        : '_x.ai/session/update',
    params: {
      sessionId: SESSION,
      update,
      _meta: { eventId: `${SESSION}-${event}`, agentTimestampMs: 1790698265166, ...meta },
    },
  }
}
const at = new Date(1790698265166).toISOString()

function call(name: string, rawInput: Record<string, unknown>, id = `call-${name}`) {
  return line({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: name,
    rawInput,
    _meta: { 'x.ai/tool': { version: 1, name, kind: 'other', namespace: 'grok_build' } },
  })
}

describe('grokRecordToItems', () => {
  it("maps a prompt and a reply, dated by Grok's event time", () => {
    expect(
      grokRecordToItems(
        line({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
          _meta: { modelId: 'fake', promptIndex: 0 },
        }),
      ),
    ).toEqual([{ id: SYNTHESIZED_ITEM_ID_PREFIX, role: 'user', ts: at, text: 'hello' }])

    expect(
      grokRecordToItems(
        line(
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there ' } },
          { promptId: '179a1a36-3d91-443a-ae16-06aa06e2f29d', chunkId: 3 },
        ),
      ),
    ).toEqual([{ id: SYNTHESIZED_ITEM_ID_PREFIX, role: 'assistant', ts: at, text: 'hi there' }])
  })

  it('leaves out what nobody typed and what is not conversation', () => {
    // A finished background task wakes Grok with a prompt of its own.
    expect(
      grokRecordToItems(
        line({
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: '<system-reminder>\nBackground task done\n</system-reminder>',
          },
          _meta: { modelId: 'fake', promptIndex: 7, hideFromScrollback: true },
        }),
      ),
    ).toEqual([])
    for (const update of [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      {
        sessionUpdate: 'hook_execution',
        event_name: 'user_prompt_submit',
        prompt_id: 'p1',
        runs: [],
      },
      // A resume writes this for a turn that died; it names the dead prompt
      // but is not its entry.
      { sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'interrupted' },
      { sessionUpdate: 'compaction_checkpoint' },
      { sessionUpdate: 'background_tasks', tasks: [] },
    ]) {
      expect(grokRecordToItems(line(update))).toEqual([])
    }
    // chat_history.jsonl records are not read at all.
    expect(grokRecordToItems({ type: 'user', content: '<user_query>\nhi\n</user_query>' })).toEqual(
      [],
    )
    expect(grokRecordToItems({ type: 'assistant', content: 'hi' })).toEqual([])
  })

  it('names the record that ends a turn, and whether the turn was answered', () => {
    // The reply itself cannot say it is final; the turn end right after it
    // does (POD-4936). Only a finished turn answered anything.
    expect(grokRecordToItems.endsTurn).toBe(grokRecordEndsTurn)
    const end = (stop_reason: string) =>
      grokRecordEndsTurn(line({ sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason }))
    expect(end('end_turn')).toBe('answered')
    for (const stop of ['cancelled', 'error', 'interrupted']) expect(end(stop)).toBe('ended')
    expect(
      grokRecordEndsTurn(
        line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
      ),
    ).toBeUndefined()
  })

  it('keeps an attachment as a tag', () => {
    expect(
      grokRecordToItems(
        line({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'image', mimeType: 'image/png' },
        }),
      ),
    ).toEqual([
      { id: SYNTHESIZED_ITEM_ID_PREFIX, role: 'user', ts: at, text: '', tags: [{ kind: 'image' }] },
    ])
  })

  it('names the command of a shell call and pairs its result', () => {
    expect(
      grokRecordToItems(
        call(
          'run_terminal_command',
          { command: 'podium issue prime', description: 'Prime current issue and ready work' },
          'call-1d7d7f3e-0',
        ),
      ),
    ).toEqual([
      {
        id: 'call-1d7d7f3e-0',
        role: 'tool',
        ts: at,
        text: '',
        toolName: 'Bash',
        toolInput: 'podium issue prime',
        toolTitle: 'Prime current issue and ready work',
        toolUseId: 'call-1d7d7f3e-0',
      },
    ])
    // A retitling update without a final status is not a result.
    expect(
      grokRecordToItems(
        line({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1d7d7f3e-0',
          title: 'Execute `podium issue prime`',
        }),
      ),
    ).toEqual([])
    expect(
      grokRecordToItems(
        line({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1d7d7f3e-0',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Usage: podium issue\n' } }],
          rawOutput: {
            type: 'Bash',
            output_for_prompt: 'exit: 0\nUsage: podium issue\n',
            exit_code: 0,
          },
        }),
      ),
    ).toEqual([
      {
        id: 'call-1d7d7f3e-0:out',
        role: 'tool',
        ts: at,
        text: '',
        toolResult: 'exit: 0\nUsage: podium issue',
        toolUseId: 'call-1d7d7f3e-0',
      },
    ])
  })

  it('maps file, search and edit calls onto the shared display names', () => {
    expect(
      grokRecordToItems(
        call('read_file', { target_file: '/repo/apps/web/src/ChatView.tsx', limit: 80 }),
      )[0],
    ).toMatchObject({
      toolName: 'Read',
      toolInput: '/repo/apps/web/src/ChatView.tsx',
      toolPaths: ['/repo/apps/web/src/ChatView.tsx'],
    })
    expect(
      grokRecordToItems(call('grep', { pattern: 'Ran a tool', glob: '*.{ts,tsx}' }))[0],
    ).toMatchObject({
      toolName: 'Grep',
      toolInput: 'Ran a tool',
    })
    const edit = grokRecordToItems(
      call('search_replace', { file_path: '/repo/src/grok.ts', old_string: 'a', new_string: 'b' }),
    )[0]
    expect(edit).toMatchObject({
      toolName: 'Edit',
      toolInput: '/repo/src/grok.ts',
      toolPaths: ['/repo/src/grok.ts'],
    })
    expect(JSON.parse(edit?.toolInputJson ?? '{}')).toMatchObject({
      kind: 'file-edit',
      path: '/repo/src/grok.ts',
      mode: 'replace',
    })
  })

  it('reads the text a tool gave the model, whatever shape its output has', () => {
    const result = (rawOutput: unknown, content: unknown = null, status = 'completed') =>
      grokRecordToItems(
        line({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status, content, rawOutput }),
      )[0]?.toolResult
    // An edit shows a diff; the model got a sentence.
    expect(
      result(
        {
          type: 'SearchReplace',
          EditsApplied: {
            tool_output_for_prompt: 'The file /repo/a.ts has been updated successfully.',
          },
        },
        [{ type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }],
      ),
    ).toBe('The file /repo/a.ts has been updated successfully.')
    expect(
      result({ type: 'ReadFile', FileContent: { content: '1→x' } }, [
        { type: 'content', content: { type: 'text', text: '1→x' } },
      ]),
    ).toBe('1→x')
    expect(result({ type: 'ListDir', Content: { content: '- /repo/\n  - a.ts' } })).toBe(
      '- /repo/\n  - a.ts',
    )
    expect(result({ type: 'TaskOutput', Result: { output: 'done\n', task_id: 't1' } })).toBe('done')
    expect(result({ type: 'Todo', TodosUpdated: { summary_for_prompt: '2 open' } })).toBe('2 open')
    expect(
      result(
        null,
        [{ type: 'content', content: { type: 'text', text: 'Hook denied: read your mail' } }],
        'failed',
      ),
    ).toBe('Hook denied: read your mail')
    // Nothing to show, nothing emitted.
    expect(result({ type: 'Monitor', taskId: 't1' })).toBeUndefined()
  })

  it('carries AskUserQuestion structure so the chat can render the card', () => {
    const items = grokRecordToItems(
      call('ask_user_question', {
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
    )
    expect(items[0]).toMatchObject({
      toolName: 'AskUserQuestion',
      toolInput: 'Reload the running server?',
    })
    expect(JSON.parse(items[0]?.toolInputJson ?? '{}').questions[0].options).toHaveLength(2)
  })
})
