/**
 * Fixture readers for the sync-status harness (POD-6852). One module stands in
 * for `@/app/header-data`, `@/features/chat/use-pool-notices` and
 * `@podium/client-core/react`; `?state=` on the page picks the fixture.
 */

import type { ConnectionCondition } from '@podium/client-core/live'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import type { MessageNotice } from '@podium/client-core/values'

export interface HarnessFixture {
  connection: ConnectionCondition
  queued: number
  notices: MessageNotice[]
  refused: OutboxDeadLetterEntry[]
}

const NOTICES = [
  {
    messageId: 'm-1',
    sessionId: 's-reviewer',
    sessionLabel: 'Reviewer: auth flow',
    excerpt: 'Check the retry path before merging',
    status: 'unknown',
    line: 'not confirmed — it may or may not have arrived',
    createdAt: '2026-11-12T11:58:00.000Z',
  },
] as unknown as MessageNotice[]

const REFUSED = [
  {
    entry: {
      mutationId: 'mut-1',
      kind: 'issueUpdate',
      input: { id: 'issue-1', patch: { title: 'Unified sync status' } },
      queuedAt: 0,
    },
    reason: { code: 'conflict' },
    parkedFrom: 'rejected',
    deadLetteredAt: 0,
    attempts: 1,
  },
] as unknown as OutboxDeadLetterEntry[]

const OK: ConnectionCondition = { state: 'online', since: 0, pingMs: 18 }
const state = new URLSearchParams(location.search).get('state') ?? 'idle'
const since = Date.now() - 2 * 60_000

export const fixture: HarnessFixture = {
  connection:
    state === 'offline'
      ? { state: 'offline', since }
      : state === 'slow'
        ? { state: 'degraded', since, pingMs: 640 }
        : OK,
  queued: state === 'sending' || state === 'offline' || state === 'wake' ? 3 : 0,
  notices: state === 'review' || state === 'wake' || state === 'offline-review' ? NOTICES : [],
  refused: state === 'review' || state === 'wake' ? REFUSED : [],
}
if (state === 'offline-review') fixture.connection = { state: 'offline', since }

// @/app/header-data
export const usePoolHeaderConnection = (): ConnectionCondition => fixture.connection
export const useHeaderOutboxSize = (): number => fixture.queued
// @/features/chat/use-pool-notices
export const usePoolMessageNoticeCount = (): number => fixture.notices.length
export const usePoolMessageNotices = (): readonly MessageNotice[] => fixture.notices
export const usePoolRecovery = (): readonly OutboxDeadLetterEntry[] => fixture.refused
// @podium/client-core/react: the hooks the review rows call
const noop = () => {}
export const useRequestClient = () => ({
  messages: { dismissNotice: { mutate: async () => ({}) } },
})
export const useUi = () => ({ openSessionTab: noop })
export const useOutboxRecovery = () => ({ retry: noop, discard: noop, edit: noop })
