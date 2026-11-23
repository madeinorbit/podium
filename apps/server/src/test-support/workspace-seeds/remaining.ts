/**
 * THE SAME-ID SEED OF RECAP WATERMARKS, QUOTA WINDOWS AND OPERATIONS, shared by its two-workspace
 * test (`store/remaining.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
 */

import { asSessionId, asUserId, type QuotaSample, type SessionId } from '@podium/model'
import type { PersistedOperation } from '../../modules/operations/store'
import type { ReaderRef } from '../../modules/sessions/read-toolkit'
import type { SessionStore } from '../../store'
import { workspaceRows } from '../store-sql'

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
export const TAGS: readonly Tag[] = ['a', 'b']
export const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')

export const SAMPLING = 15 * 60_000
export const RESETS = Date.parse('2026-11-24T01:00:00.000Z')
export const SEEN = Date.parse('2026-11-17T10:00:00.000Z')
/** When a recap watermark was set and moved: `at` is timestamptz on Postgres. */
export const MARKED_AT = '2026-11-17T09:00:00.000Z'
export const REMARKED_AT = '2026-11-17T09:30:00.000Z'

/** The workspace tables these repositories read and write. */
export const TABLES = ['recap_watermarks', 'quota_windows', 'operations', 'notices'] as const

/** One workspace's rows of every table, each in primary-key order, on either engine. */
export async function rowsOf(store: SessionStore, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) out[table] = await workspaceRows(store, table, WS[tag])
  return out
}

/** The same ids in both workspaces. */
export const READER: ReaderRef = asSessionId('sess-reader')
export const TARGET: SessionId = asSessionId('sess-target')
export const account = (name = 'main'): string => `claude-code::${name}@example.com`

export function sample(tag: Tag, over: Partial<QuotaSample> = {}): QuotaSample {
  return {
    accountKey: account(),
    agent: 'claude-code',
    windowKey: 'weekly-all',
    // The workspace's own content: a read that crossed over would answer the other label.
    label: `Weekly ${tag}`,
    usedPercent: 10,
    resetsAtMs: RESETS,
    windowMinutes: 10080,
    atMs: SEEN,
    source: 'live',
    ...over,
  }
}

/** The same operation id in both workspaces. */
export const opId = (name: string): string => `op_${name}`

/** An operation of `tag`'s workspace: the id and the exclusion group are the same in both, the
 *  step id is the workspace's own. */
export function operation(
  tag: Tag,
  name: string,
  over: Partial<PersistedOperation> = {},
): PersistedOperation {
  return {
    id: opId(name),
    kind: 'test',
    exclusionGroup: 'lifecycle',
    state: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    steps: [{ id: `${tag}-first`, state: 'running' }],
    ...over,
  }
}

/** A user-started update approval, the row `approvedTarget` serves. */
export function approval(
  tag: Tag,
  name: string,
  version: string,
  createdAt: number,
): PersistedOperation {
  return operation(tag, name, {
    kind: 'update',
    exclusionGroup: 'server-update',
    createdBy: 'user',
    createdAt,
    updatedAt: createdAt,
    state: 'done',
    finishedAt: createdAt,
    details: { channel: 'dev', target: { version, critical: false, artifacts: {} } },
  })
}

/** One workspace's rows, written through its own repositories. */
/** The same notice ids and dedupe keys in both workspaces, for the same recipient. */
export const RECIPIENT = asUserId('user:alice')
export const noticeId = (n: number): string => `ntc_${n}`
export const NOTICE_KEY = 'credential-attention:cred_1'

export async function seed(store: SessionStore, tag: Tag): Promise<void> {
  // An open notice and a read mention, the same ids in both workspaces (POD-6881).
  await store.notices.open({
    id: noticeId(1),
    recipientUserId: RECIPIENT,
    kind: 'credential-attention',
    subjectKind: 'credential',
    subjectId: 'cred_1',
    title: `${tag}: a credential needs attention`,
    dedupeKey: NOTICE_KEY,
    createdAt: MARKED_AT,
  })
  await store.notices.open({
    id: noticeId(2),
    recipientUserId: RECIPIENT,
    kind: 'mention',
    subjectKind: 'issue',
    subjectId: 'iss-1',
    title: `${tag}: you were mentioned`,
    dedupeKey: 'mention:iss-1:c1',
    createdAt: REMARKED_AT,
  })
  await store.readWatermarks.setRecapWatermark(READER, TARGET, `${tag}-mark-1`, MARKED_AT)

  // Two series: `main` with one window, `spare` with an older and a newer window.
  await store.quotaHistory.record(sample(tag), SAMPLING, null)
  await store.quotaHistory.record(
    sample(tag, { accountKey: account('spare'), resetsAtMs: RESETS - 7 * 86_400_000 }),
    SAMPLING,
    null,
  )
  await store.quotaHistory.record(sample(tag, { accountKey: account('spare') }), SAMPLING)

  // A live operation holding `lifecycle`, a finished one, a finished one whose cleanup is
  // pending, and two settled approvals.
  await store.operations.insert(operation(tag, 'live'))
  await store.operations.insert(
    operation(tag, 'finished', {
      exclusionGroup: 'reindex',
      state: 'done',
      createdAt: 900,
      updatedAt: 900,
      finishedAt: 900,
    }),
  )
  await store.operations.insert(
    operation(tag, 'cleanup', {
      exclusionGroup: 'reindex',
      state: 'failed',
      createdAt: 800,
      updatedAt: 800,
      finishedAt: 800,
      details: { cleanup: { status: 'pending' } },
    }),
  )
  await store.operations.insert(approval(tag, 'approved-old', `${tag}-1`, 500))
  await store.operations.insert(approval(tag, 'approved-new', `${tag}-2`, 600))
}
