/**
 * What `@` offers, and in what order (POD-412).
 */

import type { IssueViewModel } from '@podium/client-core/react'
import { describe, expect, it } from 'vitest'
import { fileMentions, issueMentions } from './mention-sources'

const issue = (over: Partial<IssueViewModel>): IssueViewModel =>
  ({
    id: `id-${over.seq ?? 0}`,
    seq: 0,
    title: 'Untitled',
    displayRef: 'POD-0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    ...over,
  }) as IssueViewModel

const ISSUES = [
  issue({ seq: 412, displayRef: 'POD-412', title: 'Composer context picker' }),
  issue({ seq: 376, displayRef: 'POD-376', title: 'The BIG Chatview Redesign' }),
  issue({
    seq: 394,
    displayRef: 'POD-394',
    title: 'Usage loading shape',
    updatedAt: '2026-02-01T00:00:00.000Z',
  }),
  issue({ seq: 9, displayRef: 'POD-9', title: 'Archived thing', archived: true }),
]

const refs = (query: string, limit = 5) =>
  issueMentions(ISSUES, query, limit).map((option) => option.label)

describe('issueMentions', () => {
  it('completes a ref prefix — the half of everyone who types the number', () => {
    expect(refs('POD-41')).toEqual(['POD-412'])
    expect(refs('412')).toEqual(['POD-412'])
  })

  it('completes a TITLE too, for the half who remember what it was about', () => {
    expect(refs('composer')).toEqual(['POD-412'])
    expect(refs('redesign')).toEqual(['POD-376'])
  })

  it('is case-insensitive', () => {
    expect(refs('pod-376')).toEqual(['POD-376'])
    expect(refs('CHATVIEW')).toEqual(['POD-376'])
  })

  it('ranks a ref match above a title match', () => {
    // '39' is a ref prefix for POD-394 and appears in no title.
    expect(refs('39')[0]).toBe('POD-394')
  })

  it('never offers an archived issue', () => {
    expect(refs('archived')).toEqual([])
  })

  it('opens on the most recently touched issues, not on list order', () => {
    expect(refs('')[0]).toBe('POD-394')
  })

  it('orders a queried list by issue number, so it cannot re-rank under the keyboard', () => {
    // Same evidence for all three (every ref starts 'POD-'), and POD-394 is the
    // most recently touched — if recency broke the tie it would lead, and a
    // live agent touching any issue would reshuffle the rows mid-keystroke.
    expect(refs('pod-')).toEqual(['POD-412', 'POD-394', 'POD-376'])
  })

  it('inserts the bare ref the transcript already linkifies', () => {
    expect(issueMentions(ISSUES, 'POD-412', 5)[0]).toMatchObject({
      kind: 'issue',
      insert: 'POD-412',
      detail: 'Composer context picker',
    })
  })

  it('skips an issue with no resolvable ref — an unusable row is worse than none', () => {
    const noRef = issueMentions([issue({ seq: 1, displayRef: '', title: 'Nameless' })], 'name', 5)
    expect(noRef).toEqual([])
  })

  it('honours the cap', () => {
    expect(refs('', 2)).toHaveLength(2)
  })
})

describe('fileMentions', () => {
  it('shows the filename first and the directory as context', () => {
    expect(fileMentions(['apps/web/src/features/chat/ChatComposer.tsx'])[0]).toMatchObject({
      kind: 'file',
      label: 'ChatComposer.tsx',
      detail: 'apps/web/src/features/chat',
    })
  })

  it('inserts a code span, which is what the transcript turns into a file chip', () => {
    expect(fileMentions(['README.md'])[0]).toMatchObject({
      label: 'README.md',
      detail: '',
      insert: '`README.md`',
    })
  })
})
