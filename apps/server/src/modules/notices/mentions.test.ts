/**
 * CommentMentions (POD-6881): who a comment's mentions tell. The two-member
 * test drives it through the real server; this pins the rules the server's
 * member list cannot reach today: a mentioned member who may NOT read the task
 * (every member reads every task now, design §2.2) is told nothing.
 */

import { asIssueId, asUserId, type UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { EmitNoticeInput } from './emit'
import { CommentMentions, mentionKey, mentionsColumn, parseMentionsColumn } from './mentions'

const ANN: UserId = asUserId('mem_ann')
const BEN: UserId = asUserId('mem_ben')
const CY: UserId = asUserId('mem_cy')
const ISSUE = asIssueId('iss_1')

function mentionsWith(readers: UserId[]) {
  const emitted: EmitNoticeInput[] = []
  const resolved: string[] = []
  const mentions = new CommentMentions({
    activeMembers: async () => [
      { id: ANN, displayName: 'Ann' },
      { id: BEN, displayName: 'Ben' },
      { id: CY, displayName: 'Cy' },
    ],
    readersOf: async (_issue, users) => users.filter((u) => readers.includes(u)),
    emitNotice: async (i) => {
      emitted.push(i)
    },
    resolveNotices: async (key) => {
      resolved.push(key)
    },
  })
  return { mentions, emitted, resolved }
}

const raise = (mentioned: UserId[], authorUserId: UserId | null = ANN) => ({
  issueId: ISSUE,
  issueRef: 'POD-1',
  issueTitle: 'Fix it',
  commentId: 'cmt_1',
  authorName: 'Ann',
  authorUserId,
  body: '@Ben @Cy look',
  mentioned,
})

describe('CommentMentions', () => {
  it('finds the active members a body names', async () => {
    const { mentions } = mentionsWith([])
    expect(await mentions.find('@Ben and @cy, not @Dee')).toEqual([BEN, CY])
    expect(await mentions.find('no mention here')).toEqual([])
  })

  it('tells nobody who may not read the task', async () => {
    const { mentions, emitted } = mentionsWith([BEN])
    await mentions.raise(raise([BEN, CY]))
    expect(emitted.map((e) => e.recipientUserId)).toEqual([BEN])
  })

  it('never tells the author, and tells each other reader once with the comment as anchor', async () => {
    const { mentions, emitted } = mentionsWith([ANN, BEN, CY])
    await mentions.raise(raise([ANN, BEN]))
    expect(emitted).toEqual([
      {
        recipientUserId: BEN,
        kind: 'mention',
        subject: { kind: 'issue', id: ISSUE, anchor: 'cmt_1' },
        title: 'Ann mentioned you on POD-1: Fix it',
        body: '@Ben @Cy look',
        dedupeKey: mentionKey('cmt_1', BEN),
      },
    ])
  })

  it('resolves the notices of the members it is given', async () => {
    const { mentions, resolved } = mentionsWith([])
    await mentions.resolve('cmt_1', [BEN, CY])
    expect(resolved).toEqual(['mention:cmt_1:mem_ben', 'mention:cmt_1:mem_cy'])
  })

  it('stores mentions as JSON and reads anything unreadable as none', () => {
    expect(parseMentionsColumn(mentionsColumn([BEN, CY]))).toEqual([BEN, CY])
    expect(mentionsColumn([])).toBeNull()
    expect(parseMentionsColumn(null)).toEqual([])
    expect(parseMentionsColumn('not json')).toEqual([])
    expect(parseMentionsColumn('{"a":1}')).toEqual([])
  })
})
