import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@podium/protocol'
import {
  formatTopicRecap,
  pickRecapMessages,
  TOPIC_RECAP_MAX_CHARS,
  transcriptSessionIdForThread,
  truncatePhoneText,
} from './topic-recap'

function item(
  partial: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role' | 'text'>,
): TranscriptItem {
  return partial
}

describe('transcriptSessionIdForThread', () => {
  it('prefers the superagent podium session', () => {
    expect(
      transcriptSessionIdForThread(
        { podiumSessionId: 'pod', originSessionId: 'origin' },
        'btw_origin',
      ),
    ).toBe('pod')
  })

  it('falls back to origin for btw threads without a podium session yet', () => {
    expect(
      transcriptSessionIdForThread({ originSessionId: 'sess_1' }, 'btw_sess_1'),
    ).toBe('sess_1')
  })

  it('parses btw_ thread ids when the thread row is missing', () => {
    expect(transcriptSessionIdForThread(undefined, 'btw_sess_x')).toBe('sess_x')
  })
})

describe('pickRecapMessages / formatTopicRecap', () => {
  const items: TranscriptItem[] = [
    item({ id: '1', role: 'system', text: 'seed' }),
    item({ id: '2', role: 'user', text: 'first' }),
    item({ id: '3', role: 'tool', text: '', toolName: 'Read' }),
    item({ id: '4', role: 'assistant', text: 'reply one' }),
    item({ id: '5', role: 'user', text: 'second' }),
    item({ id: '6', role: 'assistant', text: 'reply two' }),
    item({ id: '7', role: 'user', text: '   ' }),
    item({ id: '8', role: 'assistant', text: 'reply three' }),
  ]

  it('takes the last conversational messages, skipping tools and empties', () => {
    expect(pickRecapMessages(items, 3)).toEqual([
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'reply two' },
      { role: 'assistant', text: 'reply three' },
    ])
  })

  it('formats a phone-friendly recap block', () => {
    expect(formatTopicRecap(items)).toBe(
      [
        'Recent in this conversation:',
        'You: second',
        'Agent: reply two',
        'Agent: reply three',
      ].join('\n'),
    )
  })

  it('returns undefined when there is nothing conversational', () => {
    expect(formatTopicRecap([item({ id: 't', role: 'tool', text: '', toolName: 'Bash' })])).toBe(
      undefined,
    )
  })

  it('truncates long bodies to the phone cap', () => {
    const long = 'x'.repeat(TOPIC_RECAP_MAX_CHARS + 40)
    const text = formatTopicRecap([item({ id: 'a', role: 'assistant', text: long })])!
    const body = text.split('\n')[1]!
    expect(body.startsWith('Agent: ')).toBe(true)
    expect(body.endsWith('…')).toBe(true)
    expect(body.length).toBe('Agent: '.length + TOPIC_RECAP_MAX_CHARS)
  })
})

describe('truncatePhoneText', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(truncatePhoneText('  hello\nworld  ')).toBe('hello world')
  })
})
