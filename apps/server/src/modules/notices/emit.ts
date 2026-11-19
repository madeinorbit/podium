/**
 * THE ONE WAY INTO A PERSON'S INBOX (POD-6881, credential management spec §13).
 *
 * `emitNotice` raises a notice for one person; `resolveNotices` closes every
 * open notice of a key once the condition behind it has cleared. A key that is
 * still open makes the second emit a no-op: one notice, one push. Mentions are
 * one feature among several; a credential that needs attention (Task 13) and a
 * credential someone shared (Task 4) call the same two functions.
 *
 *  - THE ROW AND ITS FEED CHANGE commit in the caller's transaction (the
 *    repository's write funnel), so a rolled-back comment raises nothing.
 *  - PUSH runs after the commit, through the person's existing channels (ntfy,
 *    Telegram), only for a NEW notice of a kind the person switched on
 *    (`notifications.notices`). It carries the notice's title and body and
 *    nothing else; a failed push is logged and leaves the notice in place.
 *  - BOUNDED: event notices (a mention, a share) never resolve by themselves,
 *    so a person keeps the newest {@link READ_EVENT_NOTICES_KEPT} of them once
 *    read; reading resolves the older ones.
 *
 * `emitNotice` and `resolveNotices` are module functions (the epic's shared
 * names) over the service the server binds at boot ({@link bindNoticeService}).
 */

import { randomUUID } from 'node:crypto'
import { createLogger, describeError } from '@podium/logger'
import {
  isEventNoticeKind,
  type NoticeKind,
  type NoticePushPreferences,
  type NoticeSubject,
  type NoticeWire,
  type UserId,
} from '@podium/model'
import { afterCommit, spanOpen } from '../../store/executor/executor'
import type { NoticeRow, NoticesRepository } from '../../store/notices'
import { outsideWriteProvenance } from '../../write-provenance'
import { noticeWireOf } from './records'

const log = createLogger('server:notices')

/** Read event notices kept per person; older ones are resolved when more are read. */
export const READ_EVENT_NOTICES_KEPT = 50
/** A notice's line of text is cut to this many characters. */
export const NOTICE_BODY_MAX = 280
const NOTICE_TITLE_MAX = 200
const LIST_LIMIT_DEFAULT = 50

export interface EmitNoticeInput {
  readonly recipientUserId: UserId
  readonly kind: NoticeKind
  readonly subject: NoticeSubject
  readonly title: string
  readonly body?: string
  readonly dedupeKey: string
}

/** Which preference switches each kind's push. */
const PUSH_SWITCH: Readonly<Record<NoticeKind, keyof NoticePushPreferences>> = {
  mention: 'mention',
  'credential-attention': 'credentialAttention',
  'credential-shared': 'credentialShared',
}

export interface NoticeServiceDeps {
  readonly notices: Pick<
    NoticesRepository,
    | 'open'
    | 'resolveByKey'
    | 'listOpen'
    | 'countUnread'
    | 'markRead'
    | 'markAllRead'
    | 'resolveReadEventsBeyond'
  >
  /** The recipient's push switches, read when the push is sent. */
  pushPreferences(user: UserId): Promise<NoticePushPreferences>
  /** Send through the recipient's existing channels (`NotifyService.notifyExternal`). */
  push(user: UserId, message: { title: string; body: string }): Promise<void>
  readonly now?: () => string
  readonly mintId?: () => string
}

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

export class NoticeService {
  private readonly now: () => string
  private readonly mintId: () => string

  constructor(private readonly deps: NoticeServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.mintId = deps.mintId ?? (() => `ntc_${randomUUID()}`)
  }

  async emitNotice(i: EmitNoticeInput): Promise<void> {
    const { notice, created } = await this.deps.notices.open({
      id: this.mintId(),
      recipientUserId: i.recipientUserId,
      kind: i.kind,
      subjectKind: i.subject.kind,
      subjectId: i.subject.id,
      subjectAnchor: i.subject.anchor ?? null,
      title: cut(i.title, NOTICE_TITLE_MAX),
      body: i.body === undefined ? null : cut(i.body, NOTICE_BODY_MAX),
      dedupeKey: i.dedupeKey,
      createdAt: this.now(),
    })
    if (!created) return
    await this.afterCommitOrNow(async () => await this.pushIfWanted(i.kind, notice))
  }

  async resolveNotices(dedupeKey: string): Promise<void> {
    await this.deps.notices.resolveByKey(dedupeKey, this.now())
  }

  /** The caller's open notices, newest first. */
  async list(
    user: UserId,
    page: { limit?: number; before?: { createdAt: string; id: string } },
  ): Promise<NoticeWire[]> {
    const rows = await this.deps.notices.listOpen(user, {
      limit: page.limit ?? LIST_LIMIT_DEFAULT,
      ...(page.before !== undefined ? { before: page.before } : {}),
    })
    return rows.map(noticeWireOf)
  }

  async unreadCount(user: UserId): Promise<number> {
    return await this.deps.notices.countUnread(user)
  }

  /** Mark one of the caller's notices read; false when it is not theirs, open and unread. */
  async markRead(user: UserId, id: string): Promise<boolean> {
    const at = this.now()
    const row = await this.deps.notices.markRead(user, id, at)
    if (row === null) return false
    if (isEventNoticeKind(row.kind as NoticeKind)) await this.cap(user, at)
    return true
  }

  /** Mark every open notice of the caller read; the number marked. */
  async markAllRead(user: UserId): Promise<number> {
    const at = this.now()
    const rows = await this.deps.notices.markAllRead(user, at)
    if (rows.length > 0) await this.cap(user, at)
    return rows.length
  }

  private async cap(user: UserId, at: string): Promise<void> {
    await this.deps.notices.resolveReadEventsBeyond(user, READ_EVENT_NOTICES_KEPT, at)
  }

  private async pushIfWanted(kind: NoticeKind, notice: NoticeRow): Promise<void> {
    try {
      const recipient = notice.recipientUserId
      const prefs = await this.deps.pushPreferences(recipient)
      if (!prefs[PUSH_SWITCH[kind]]) return
      await this.deps.push(recipient, { title: notice.title, body: notice.body ?? '' })
    } catch (error) {
      log.warn('notices: push failed', { kind, error: describeError(error) })
    }
  }

  /** Inside a unit of work, once it commits (never on a rollback); else now. */
  private async afterCommitOrNow(step: () => Promise<void>): Promise<void> {
    if (!spanOpen()) {
      await step()
      return
    }
    afterCommit(async () => await outsideWriteProvenance(step), 'notices.push')
  }
}

let bound: NoticeService | undefined

/** Bind the service the module functions use; returns the unbind. */
export function bindNoticeService(service: NoticeService): () => void {
  bound = service
  return () => {
    if (bound === service) bound = undefined
  }
}

function boundService(): NoticeService {
  if (bound === undefined) throw new Error('no notice service is bound')
  return bound
}

/** Raise a notice for one person (spec §13): one open notice per key. */
export async function emitNotice(i: EmitNoticeInput): Promise<void> {
  await boundService().emitNotice(i)
}

/** Close every open notice of a key, whoever it is for. */
export async function resolveNotices(dedupeKey: string): Promise<void> {
  await boundService().resolveNotices(dedupeKey)
}
