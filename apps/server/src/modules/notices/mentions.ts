/**
 * MENTIONS IN ISSUE COMMENTS (POD-6881, credential management spec §13).
 *
 * `@<display name>` in a comment is matched against the ACTIVE members when the
 * comment is written or edited (`findMentions`), and the matched ids are stored
 * on the comment. Each newly mentioned member gets one notice, keyed
 * `mention:<comment>:<member>`, unless they wrote the comment (its author is
 * the human it was written for, so a member's agent mentioning that member
 * raises nothing) or may not read the issue. A disabled account or a name that
 * is no member matches nothing. A name an edit or a delete drops has its notice
 * resolved.
 */

import type { IssueId, MentionableMember, UserId } from '@podium/model'
import { findMentions } from '@podium/model'
import type { CommentMentionsPort } from '../issues/service/types'
import type { EmitNoticeInput } from './emit'

export interface CommentMentionsDeps {
  /** Every active (not disabled) member. */
  activeMembers(): Promise<MentionableMember[]>
  /** Which of these members may read the issue. */
  readersOf(issueId: IssueId, users: readonly UserId[]): Promise<UserId[]>
  emitNotice(i: EmitNoticeInput): Promise<void>
  resolveNotices(dedupeKey: string): Promise<void>
}

export const mentionKey = (commentId: string, user: UserId): string =>
  `mention:${commentId}:${user}`

/** The text a mention notice shows under its title. */
const MENTION_BODY_MAX = 280

export class CommentMentions implements CommentMentionsPort {
  constructor(private readonly deps: CommentMentionsDeps) {}

  async find(body: string): Promise<UserId[]> {
    if (!body.includes('@')) return []
    return findMentions(body, await this.deps.activeMembers())
  }

  async raise(i: Parameters<CommentMentionsPort['raise']>[0]): Promise<void> {
    const candidates = i.mentioned.filter((user) => user !== i.authorUserId)
    if (candidates.length === 0) return
    const readers = new Set(await this.deps.readersOf(i.issueId, candidates))
    for (const user of candidates) {
      if (!readers.has(user)) continue
      await this.deps.emitNotice({
        recipientUserId: user,
        kind: 'mention',
        subject: { kind: 'issue', id: i.issueId, anchor: i.commentId },
        title: `${i.authorName} mentioned you on ${i.issueRef}: ${i.issueTitle}`,
        body: i.body.slice(0, MENTION_BODY_MAX),
        dedupeKey: mentionKey(i.commentId, user),
      })
    }
  }

  async resolve(commentId: string, users: readonly UserId[]): Promise<void> {
    for (const user of users) await this.deps.resolveNotices(mentionKey(commentId, user))
  }
}

/** The stored form of a comment's mentions. */
export const mentionsColumn = (users: readonly UserId[]): string | null =>
  users.length === 0 ? null : JSON.stringify(users)

/** Read the stored form back; anything unreadable is no mentions. */
export function parseMentionsColumn(value: string | null | undefined): UserId[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is UserId => typeof v === 'string' && v !== '')
      : []
  } catch {
    return []
  }
}
