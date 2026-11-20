/**
 * THE NOTICE: one message for one person (credential management spec §13,
 * POD-6881).
 *
 * A notice is what a feature puts in a person's inbox: a mention in an issue
 * comment, a credential of theirs that needs attention, someone giving them use
 * of a credential. It has a kind, the thing it is about, a title and a line of
 * text, when it was read and when it was resolved. Only OPEN notices reach a
 * client; a resolved one leaves the feed.
 *
 * Event kinds (a mention, a share) have no condition that could clear them, so
 * they never resolve by themselves; condition kinds (attention) resolve when the
 * condition clears.
 */

import { z } from 'zod'
import { asUserId, type UserId, UserIdField } from '../ids'
import { type EntityKind, joinKeyParts, splitKeyParts } from '../ids/keys'

export const NOTICE_KINDS = [
  'mention',
  'credential-attention',
  'credential-shared',
  /** A Podium-installed harness's updates have failed for three days (managed installs §8). */
  'harness-install-failing',
  /** A machine's install ledger was lost or damaged and rebuilt (managed installs §7). */
  'harness-ledger-rebuilt',
] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export const isNoticeKind = (v: string): v is NoticeKind =>
  (NOTICE_KINDS as readonly string[]).includes(v)

const EVENT_KINDS: ReadonlySet<NoticeKind> = new Set([
  'mention',
  'credential-shared',
  'harness-ledger-rebuilt',
])

/** An event happened once and nothing clears it; a condition clears itself. */
export const isEventNoticeKind = (kind: NoticeKind): boolean => EVENT_KINDS.has(kind)

/** What a notice is about. A comment is its issue with the comment as anchor. */
export interface NoticeSubject {
  readonly kind: EntityKind
  readonly id: string
  readonly anchor?: string
}

/**
 * The notice as a client sees it (synced record `inboxNotice`). Kind and
 * subject kind are open strings, so a client older than a new kind still
 * shows the row. It carries no secret: titles name a credential by its label.
 */
export const NoticeWire = z.object({
  noticeId: z.string(),
  recipientUserId: UserIdField,
  kind: z.string(),
  subjectKind: z.string(),
  subjectId: z.string(),
  subjectAnchor: z.string().optional(),
  title: z.string(),
  body: z.string().optional(),
  createdAt: z.string(),
  readAt: z.string().optional(),
})
export type NoticeWire = z.infer<typeof NoticeWire>

const ROW_SEP = '\n'

/** The feed id names the recipient, so per-user visibility reads it from the id. */
export function noticeRowId(recipientUserId: UserId, noticeId: string): string {
  return joinKeyParts(ROW_SEP, [recipientUserId, noticeId])
}

/** Inverse of {@link noticeRowId}. Throws on a malformed id. */
export function parseNoticeRowId(id: string): { userId: UserId; noticeId: string } {
  const [user, notice] = splitKeyParts(ROW_SEP, id, 2) as [string, string]
  if (user === '' || notice === '') {
    throw new Error(`malformed notice row id: ${JSON.stringify(id)}`)
  }
  return { userId: asUserId(user), noticeId: notice }
}

/** A member a comment can mention. */
export interface MentionableMember {
  readonly id: UserId
  readonly displayName: string
}

const WORD = /[\p{L}\p{N}_]/u

/**
 * THE MEMBERS A TEXT MENTIONS: `@<display name>`, case-insensitive. The `@`
 * starts the text or follows a non-word character (so an e-mail address is no
 * mention); the longest matching name wins and must end at a word boundary.
 * Every member carrying a matched name is mentioned: two people with one name
 * cannot be told apart in plain text. Each id appears once, in text order.
 */
export function findMentions(body: string, members: readonly MentionableMember[]): UserId[] {
  const byLength = members
    .filter((m) => m.displayName.trim() !== '')
    .map((m) => ({ id: m.id, name: m.displayName.toLocaleLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length)
  const lower = body.toLocaleLowerCase()
  const found: UserId[] = []
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && WORD.test(lower[at - 1] ?? '')) continue
    const rest = lower.slice(at + 1)
    let matched: string | undefined
    for (const m of byLength) {
      if (matched !== undefined && m.name.length < matched.length) break
      if (!rest.startsWith(m.name)) continue
      if (WORD.test(rest[m.name.length] ?? '')) continue
      matched = m.name
      if (!found.includes(m.id)) found.push(m.id)
    }
  }
  return found
}
