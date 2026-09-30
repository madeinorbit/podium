import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude-code/transcript.js'
import { codexRecordToItems } from './codex/transcript.js'
import { grokRecordToItems } from './grok/transcript.js'
import { opencodePartToItems, type OpencodeMessagePartRow } from './opencode/transcript.js'

/**
 * ONE REPLY PER AGENT RENDERS THE SAME LABEL (POD-4809).
 *
 * The chat renders "Answer" iff the assistant item carries `answer: true`
 * (ChatBlockView `isAnswer`) and "Process" for assistant prose without it
 * (TranscriptFeed `isProcessRow`). Claude and Codex grammars already mark
 * their final reply; OpenCode and Grok never did, so the same kind of reply
 * rendered PROCESS on those two families and ANSWER on the other two.
 */
function opencodeRow(message: unknown, part: unknown): OpencodeMessagePartRow {
  return {
    messageId: 'msg-1',
    partId: 'prt-1',
    sessionId: 'ses-1',
    timeCreated: 1_700_000_000_000,
    timeUpdated: 1_700_000_000_100,
    messageData: JSON.stringify(message),
    partData: JSON.stringify(part),
  }
}

describe('one final reply per agent carries answer:true', () => {
  it('claude: stop_reason end_turn', () => {
    const [item] = claudeRecordToItems({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-09-29T00:00:00.000Z',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The parser is fixed.' }],
      },
    })
    expect(item).toMatchObject({ role: 'assistant', text: 'The parser is fixed.', answer: true })
  })

  it('codex: phase final_answer', () => {
    const [item] = codexRecordToItems({
      type: 'response_item',
      timestamp: '2026-09-29T00:00:00.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'msg-1',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'The parser is fixed.' }],
      },
    })
    expect(item).toMatchObject({ role: 'assistant', text: 'The parser is fixed.', answer: true })
  })

  it('opencode: finish stop', () => {
    const [item] = opencodePartToItems(
      opencodeRow({ role: 'assistant', finish: 'stop' }, { type: 'text', text: 'The parser is fixed.' }),
    )
    expect(item).toMatchObject({ role: 'assistant', text: 'The parser is fixed.', answer: true })
  })

  // Grok's terminal history is `updates.jsonl` since POD-4875: a reply is one
  // `agent_message_chunk` record with no sign of whether it is the last of its
  // turn, so a per-record grammar cannot mark it. POD-4936 decides how.
  it.todo('grok: the final reply of a turn (POD-4936)')
})

describe('intermediate narration stays process (no answer flag)', () => {
  it('opencode: finish tool-calls', () => {
    const [item] = opencodePartToItems(
      opencodeRow(
        { role: 'assistant', finish: 'tool-calls' },
        { type: 'text', text: 'Let me check that now…' },
      ),
    )
    expect(item).toMatchObject({ role: 'assistant' })
    expect(item?.answer).toBeUndefined()
  })

  it('grok: a reply chunk ahead of a tool call', () => {
    const [item] = grokRecordToItems({
      method: 'session/update',
      params: {
        sessionId: 'grok-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: "I'll check what's already on the board." },
        },
        _meta: { agentTimestampMs: 1_790_698_265_166 },
      },
    })
    expect(item).toMatchObject({ role: 'assistant', text: "I'll check what's already on the board." })
    expect(item?.answer).toBeUndefined()
  })
})
