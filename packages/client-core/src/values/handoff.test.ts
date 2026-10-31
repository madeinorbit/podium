import { asSessionId, type TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { pairLatestPromptAndAnswer } from './handoff'
import { parseEnvelopeBatch } from './message-envelope'

const item = (id: string, over: Partial<TranscriptItem> = {}): TranscriptItem => ({
  id,
  role: 'assistant',
  text: id,
  ...over,
})

describe('Handoff transcript context', () => {
  it('ignores machine context and interrupts, and pairs only the latest turn', () => {
    const mail =
      '[podium message msg_1 · from issue:POD-1 · to your session · reply: podium mail reply msg_1]\ninternal\n[end podium message msg_1]'
    const pair = pairLatestPromptAndAnswer(
      asSessionId('s1'),
      [
        item('machine', { role: 'user', text: '<superagent-context>seed</superagent-context>' }),
        item('old-prompt', { role: 'user', text: 'old' }),
        item('old-answer', { answer: true }),
        item('interrupt', { role: 'user', event: 'interrupt', text: 'stop' }),
        item('prompt', {
          role: 'user',
          cursor: 'prompt-cursor',
          text: `${mail}latest`,
        }),
        item('narration', { text: 'working' }),
        item('answer', { cursor: 'answer-cursor', answer: true, text: 'done' }),
      ],
      {
        collapseMachineContext: true,
        operatorTextOf: (text) => parseEnvelopeBatch(text)?.operatorText,
      },
    )
    expect(pair?.prompt.anchor.itemKey).toBe('prompt-cursor')
    expect(pair?.prompt.item.text).toBe('latest')
    expect(pair?.answer?.anchor.itemKey).toBe('answer-cursor')
    expect(pair?.answer?.legacy).toBe(false)
  })

  it('uses latest assistant prose only when the transcript has no answer markers', () => {
    const pair = pairLatestPromptAndAnswer(
      asSessionId('s1'),
      [
        item('prompt', { role: 'user', text: 'question' }),
        item('reply-1', { text: 'first' }),
        item('reply-2', { text: 'latest' }),
      ],
      { collapseMachineContext: false },
    )
    expect(pair?.answer?.item.id).toBe('reply-2')
    expect(pair?.answer?.legacy).toBe(true)
  })
})
