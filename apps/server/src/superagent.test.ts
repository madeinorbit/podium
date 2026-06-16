import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { buildBtwDelta, buildBtwSeed, transcriptDelta } from './superagent'

const item = (o: Partial<TranscriptItem>): TranscriptItem => ({
  id: 'i',
  role: 'user',
  text: '',
  ...o,
})

describe('transcriptDelta', () => {
  const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
  it('returns items after the watermark id', () => {
    expect(transcriptDelta(items, { itemId: 'a' }).map((i) => i.id)).toEqual(['b', 'c'])
  })
  it('returns all when the watermark id is missing (transcript rolled)', () => {
    expect(transcriptDelta(items, { itemId: 'zzz' }).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('returns all when there is no watermark yet', () => {
    expect(transcriptDelta(items, {}).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('returns empty when caught up', () => {
    expect(transcriptDelta(items, { itemId: 'c' })).toEqual([])
  })
})

describe('buildBtwSeed', () => {
  const items: TranscriptItem[] = [
    item({ id: 'u1', role: 'user', text: 'do thing', ts: '2026-06-16T07:00:00Z' }),
    item({ id: 't1', role: 'tool', toolName: 'Bash', toolResult: 'x'.repeat(5000) }),
    item({ id: 'a1', role: 'assistant', text: 'done', ts: '2026-06-16T07:01:00Z' }),
    item({ id: 'u2', role: 'user', text: 'next thing', ts: '2026-06-16T07:02:00Z' }),
  ]
  const seed = buildBtwSeed({
    session: { sessionId: 's1', name: 'feat-x', agentKind: 'claude-code', cwd: '/repo' },
    summary: 'Working on X.',
    items,
    maxChars: 20_000,
  })
  it('marks the section, session, summary, and caught-up watermark', () => {
    expect(seed).toContain('[BTW CONTEXT]')
    expect(seed).toContain('s1')
    expect(seed).toContain('Working on X.')
    expect(seed).toContain('u2') // last item id = caught-up marker
  })
  it('includes every user message verbatim', () => {
    expect(seed).toContain('do thing')
    expect(seed).toContain('next thing')
  })
  it('truncates long tool results and stays within budget', () => {
    expect(seed.length).toBeLessThanOrEqual(20_000)
    expect(seed).not.toContain('x'.repeat(1000))
  })
  it('omits the summary line when none is given', () => {
    expect(buildBtwSeed({ session: { sessionId: 's1' }, items })).not.toContain('Summary:')
  })
})

describe('buildBtwDelta', () => {
  it('marks the previous and new watermarks and lists new items', () => {
    const delta = [item({ id: 'n1', role: 'user', text: 'more', ts: '2026-06-16T09:00:00Z' })]
    const msg = buildBtwDelta({
      prev: { itemId: 'u2', ts: '2026-06-16T07:02:00Z' },
      delta,
      now: '2026-06-16T09:01:00Z',
    })
    expect(msg).toContain('[BTW UPDATE @ 2026-06-16T09:01:00Z]')
    expect(msg).toContain('u2') // previous watermark
    expect(msg).toContain('more')
    expect(msg).toContain('n1') // new watermark
  })
})
