/**
 * THE SAME-ID SEED OF SESSIONS AND USER STATE, shared by its two-workspace test
 * (`store/sessions.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
 */

import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import type { SessionStore } from '../../store'
import type { SessionRow } from '../../store/types'
import { storeSql, workspaceRows } from '../store-sql'

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
export const TAGS = ['a', 'b'] as const
export const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
/** Each workspace's own timestamp and snooze end: content, not keys. */
export const AT_OF: Record<Tag, string> = {
  a: '2026-11-17T10:00:00.000Z',
  b: '2026-11-17T11:00:00.000Z',
}
export const LATER_OF: Record<Tag, string> = {
  a: '2099-01-01T00:00:00.000Z',
  b: '2099-02-01T00:00:00.000Z',
}
export const AT = AT_OF.a
export const LATER = LATER_OF.a
export const scope = fixtureWriteScope()

// The same ids in both workspaces.
export const user = (name = 'alice'): UserId => asUserId(`user:${name}`)
export const ALICE = user()
export const BOB = user('bob')
export const sid = (n: number): SessionId => asSessionId(`s${n}`)
export const iss = (n: number): IssueId => asIssueId(`iss-${n}`)
export const MACHINE = asMachineId('machine-1')
export const ROOT = '/repo'
/** The sessions' owner: the same people in both, a different owner per workspace. */
export const owner = (tag: Tag): UserId => (tag === 'a' ? ALICE : BOB)
/** Alice's and Bob's dock shells: the same worktrees, a different shell per workspace. */
export const shell = (tag: Tag, who: 'alice' | 'bob'): SessionId =>
  who === 'alice' ? sid(tag === 'a' ? 1 : 3) : sid(tag === 'a' ? 2 : 5)
/** Alice's tab order: the same sessions, a different order per workspace. */
export const aliceOrder = (tag: Tag): SessionId[] =>
  tag === 'a' ? [sid(2), sid(1)] : [sid(1), sid(2)]

// The ids only one workspace holds.
/** A session only `tag`'s workspace holds. */
export const only = (tag: Tag): SessionId => asSessionId(`only-${tag}`)
/** An issue only `tag`'s workspace holds, which the OTHER workspace's s5 names. */
export const heldBy = (tag: Tag): IssueId => asIssueId(`held-by-${tag}`)

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
export const TABLES = [
  'sessions',
  'pins',
  'snoozes',
  'session_user_state',
  'offers',
  'tab_order',
  'session_drafts',
  'runtime_event_checkpoints',
  'user_layout',
  'user_dock_shell',
  'user_preferences',
  'user_read_position',
  'issues',
] as const

/** One workspace's rows of every table, each in primary-key order, on either engine. */
export async function rowsOf(store: SessionStore, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) out[table] = await workspaceRows(store, table, WS[tag])
  return out
}

export function session(tag: Tag, n: number, patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: sid(n),
    ownerUserId: owner(tag),
    agentKind: 'codex',
    cwd: `${ROOT}/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `resume-${n}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${n}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: MACHINE,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: 'parent',
    headless: false,
    issueId: null,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    stoppedAt: null,
    stopReason: null,
    workflowRunId: null,
    workflowStepId: null,
    agentProfileId: null,
    deletedAt: null,
    deletionSource: null,
    deletedByIssueId: null,
    ...patch,
  }
}

/** An issue row, raw: the issues repository is another task's (B2). */
export async function insertIssue(
  store: SessionStore,
  tag: Tag,
  id: IssueId,
  seq: number,
): Promise<void> {
  await storeSql(store).run(
    sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq, title,
          stage, default_agent, created_at, updated_at)
        VALUES (${WS[tag]}, ${id}, ${owner(tag)}, ${owner(tag)}, ${ROOT}, 'repo-1', ${seq},
                ${`${tag} issue ${seq}`}, 'backlog', 'codex', ${AT_OF[tag]}, ${AT_OF[tag]})`,
  )
}

/**
 * One workspace's rows, written through its own repositories. Sessions, the same ids in both:
 *   s1 live, ref-less, on the machine;     s2 live, born on issue 1 (letter A), bound to it;
 *   s3 headless, draft ref 7, child of s1; s4 tombstoned by issue 2 (bound to it);
 *   s5 live, ref-less, bound to an issue only the OTHER workspace holds.
 * And `only-<tag>`, live and ref-less, which only this workspace holds: Alice pinned and read
 * it, Bob snoozed it.
 */
export async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const at = AT_OF[tag]
  await insertIssue(store, tag, iss(1), 1)
  await insertIssue(store, tag, iss(2), 2)
  await insertIssue(store, tag, heldBy(tag), 9)
  await store.sessions.upsertSessions(scope, [
    session(tag, 1),
    session(tag, 2, { refIssueId: iss(1), refLetter: 'A', issueId: iss(1) }),
    session(tag, 3, { headless: true, refDraft: 7, spawnedBy: sid(1), status: 'hibernated' }),
    session(tag, 4, { issueId: iss(2) }),
    session(tag, 8, { id: only(tag), resumeValue: `resume-only-${tag}` }),
  ])
  await store.sessions.upsertSession(
    scope,
    session(tag, 5, {
      issueId: heldBy(other(tag)),
      lifecycle: {
        desired: 'stopped',
        force: false,
        revision: 2,
        observedRevision: 1,
        failure: null,
        byUser: owner(tag),
        byAgent: null,
      },
    }),
  )
  await store.sessions.softDeleteForIssue(scope, [sid(4)], iss(2), at)

  await store.sessions.addPin(ALICE, 'panel', sid(1), at)
  await store.sessions.addPin(ALICE, 'panel', only(tag), at)
  await store.sessions.addPin(BOB, 'issue', iss(1), at)
  await store.sessions.markSessionRead(scope, ALICE, sid(1), at)
  await store.sessions.markSessionRead(scope, ALICE, only(tag), at)
  await store.sessions.markSessionRead(scope, BOB, sid(1), at)
  await store.sessions.setSnooze(scope, ALICE, sid(2), LATER_OF[tag])
  await store.sessions.setSnooze(scope, BOB, sid(1), null)
  await store.sessions.setSnooze(scope, BOB, only(tag), null)
  await store.sessions.setOffer(scope, sid(1), {
    message: `${tag} offer`,
    actions: [{ label: 'Go', prompt: 'go' }],
    createdAt: at,
  })
  await store.sessions.setTabOrder(ALICE, ROOT, aliceOrder(tag))
  await store.sessions.setTabOrder(BOB, ROOT, [sid(1)])
  await store.sessions.setDraft(sid(1), `${tag} draft`)
  await store.sessions.setDraftDoc(sid(2), {
    text: `${tag} doc`,
    updatedAt: at,
    rev: 3,
    origin: `${tag}-device`,
    history: [`${tag}-h1`],
  })
  await storeSql(store).run(
    sql`INSERT INTO runtime_event_checkpoints (workspace_id, session_id, observer_generation,
          cursor_json, turn_epoch, updated_at) VALUES (${WS[tag]}, ${sid(1)}, 1, '{}', 1, ${at})`,
  )

  await store.layout.set(scope, ALICE, 'dockTab', `${tag}-files`, at)
  await store.layout.set(scope, BOB, 'superOpen', tag === 'a', at)
  await store.dockShells.set(ALICE, `${ROOT}/w1`, shell(tag, 'alice'), at)
  await store.dockShells.set(BOB, `${ROOT}/w2`, shell(tag, 'bob'), at)
  await store.settings.userPreferences.set(ALICE, 'roles.coding.model', `${tag}-model`, at)
  await store.settings.userPreferences.set(BOB, 'notifications.ntfyTopic', `${tag}-topic`, at)
  await store.readPositions.advance(
    scope,
    ALICE,
    'issueEvents',
    { lastEventId: tag === 'a' ? 10 : 20, seenAt: at },
    at,
  )
  await store.readPositions.advance(
    scope,
    BOB,
    'issueEvents',
    { lastEventId: tag === 'a' ? 5 : 6, seenAt: at },
    at,
  )
}
