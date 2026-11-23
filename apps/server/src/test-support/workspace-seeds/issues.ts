/**
 * THE SAME-ID SEED OF ISSUES, shared by its two-workspace test (`store/issues.workspace.test.ts`)
 * and the completeness test (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that
 * test unchanged: both workspaces hold the same ids and natural keys, with content of their own
 * (see the test's header).
 */

import {
  asIssueId,
  asIssuePanelItemId,
  asMachineId,
  asRepoId,
  asSessionId,
  asUserId,
  type IssueId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { expect } from 'vitest'
import type { SessionStore } from '../../store'
import type { IssueRow } from '../../store/types'
import { issueRowFixture } from '../issue-row'
import { storeSql, workspaceRows } from '../store-sql'

export type Tag = 'a' | 'b'
export const TAGS = ['a', 'b'] as const
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
/** Each workspace's own timestamp: content, not a key. */
export const AT_OF: Record<Tag, string> = {
  a: '2026-11-17T10:00:00.000Z',
  b: '2026-11-17T10:30:00.000Z',
}
export const LATER = '2026-11-17T11:00:00.000Z'
export const scope = fixtureWriteScope()

export const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
// The same ids and natural keys in both workspaces.
export const user = (name = 'alice'): UserId => asUserId(`user:${name}`)
export const ALICE = user()
export const BOB = user('bob')
export const iss = (n: number): IssueId => asIssueId(`iss-${n}`)
export const REPO = asRepoId('repo-1')
export const ROOT = '/repo'
export const MACHINE = asMachineId('machine-1')
export const comment = (n: number) => `comment-${n}`
export const message = (n: number) => `mail-${n}`
export const todo = (n: number) => asIssuePanelItemId(`todo-${n}`)
export const artifact = (n: number) => asIssuePanelItemId(`artifact-${n}`)
export const deferred = (n: number) => asIssuePanelItemId(`deferred-${n}`)
/** The issues' owner: the same people in both, a different owner per workspace. */
export const owner = (tag: Tag): UserId => (tag === 'a' ? ALICE : BOB)
/** The labels issue 1 carries: the same names, `ui` only in A. */
export const labelsOf = (tag: Tag): string[] => (tag === 'a' ? ['bug', 'ui'] : ['bug'])
/** The position of the panel items: content, so `next` tells the workspaces apart. */
export const position = (tag: Tag): number => (tag === 'a' ? 0 : 1)
// An id only `tag`'s workspace holds.
export const only = (tag: Tag): IssueId => asIssueId(`only-${tag}`)

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
export const TABLES = [
  'issues',
  'labels',
  'issue_labels',
  'issue_deps',
  'issue_comments',
  'issue_text_revisions',
  'issue_messages',
  'issue_message_user_state',
  'issue_user_state',
  'issue_ref_letters',
  'issue_panel_todos',
  'issue_panel_artifacts',
  'issue_panel_deferred',
  'issue_panel_states',
  'issue_git_states',
] as const

/** One workspace's rows of every table, each in primary-key order, on either engine. */
export async function rowsOf(store: SessionStore, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) out[table] = await workspaceRows(store, table, WS[tag])
  return out
}

/**
 * One workspace's issues, in the repository `repo-1` at `/repo` (the same in both):
 *   1 parent, open, top level, labelled, deferred;
 *   2 child of 1, blocked by 3, with a worktree on the machine;
 *   3 child of 1, done;
 *   4 top level, deleted;
 *   5 top level, a legacy worktree with no machine.
 */
export function issue(tag: Tag, n: number, patch: Partial<IssueRow> = {}): IssueRow {
  return issueRowFixture({
    id: iss(n),
    ownerUserId: owner(tag),
    createdByActor: owner(tag),
    createdByOnBehalfOf: owner(tag),
    repoPath: ROOT,
    repoId: REPO,
    seq: n,
    title: `${tag} issue ${n}`,
    description: `${tag} text ${n}`,
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    machineId: null,
    parentId: null,
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    revision: 1,
    sortKey: null,
    deferUntil: null,
    deletedAt: null,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    updatedAt: `2026-11-0${n}T00:00:00.000Z`,
    ...patch,
  } as Partial<IssueRow> as never)
}

/** A machine row, raw: the machines repository is another task's. */
export async function insertMachine(store: SessionStore, tag: Tag, id: string): Promise<void> {
  await storeSql(store).run(
    sql`INSERT INTO machines (workspace_id, id, name, hostname, token_hash, created_at, last_seen_at)
        VALUES (${WS[tag]}, ${id}, ${`${tag} machine`}, ${`${tag}-host`}, ${`${tag}-token-${id}`},
                ${AT_OF[tag]}, ${AT_OF[tag]})`,
  )
}

export async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const s = store.issues
  const at = AT_OF[tag]
  await insertMachine(store, tag, MACHINE)
  await s.upsertIssue(scope, issue(tag, 1, { deferUntil: LATER, sortKey: 'm' }))
  await s.upsertIssue(
    scope,
    issue(tag, 2, {
      parentId: iss(1),
      stage: 'in_progress',
      worktreePath: `${ROOT}/.worktrees/two`,
      machineId: MACHINE,
    }),
  )
  await s.upsertIssue(scope, issue(tag, 3, { parentId: iss(1), stage: 'done' }))
  await s.upsertIssue(scope, issue(tag, 4, { deletedAt: at }))
  await s.upsertIssue(scope, issue(tag, 5, { worktreePath: `${ROOT}/.worktrees/five` }))

  await s.setIssueLabels(iss(1), labelsOf(tag))
  await s.addIssueDep(iss(2), iss(3))
  await s.addIssueDep(iss(2), iss(1), 'related')
  await s.addIssueComment({
    id: comment(1),
    issueId: iss(1),
    author: owner(tag),
    body: `${tag} needle one`,
    createdAt: at,
  })
  await s.addIssueComment({
    id: comment(2),
    issueId: iss(2),
    author: owner(tag),
    body: `${tag} needle two`,
    createdAt: LATER,
  })
  await s.appendIssueTextRevision({
    issueId: iss(1),
    field: 'description',
    body: `${tag} text first`,
    source: 'create',
    restoredFrom: null,
    issueRevision: 1,
    actor: owner(tag),
    onBehalfOf: owner(tag),
    createdAt: at,
  })
  for (const n of [1, 2]) {
    await s.addIssueMessage({
      id: message(n),
      issueId: iss(1),
      fromAuthor: owner(tag),
      body: `${tag} mail ${n}`,
      createdAt: n === 1 ? at : LATER,
      status: 'unread',
      claimedBy: null,
      claimedAt: null,
    })
  }
  await s.markIssueMessagesRead(ALICE, iss(1), [message(1)], at)
  await s.setIssueUserState(scope, ALICE, iss(1), { readAt: at })
  await s.setIssueUserState(scope, BOB, iss(2), { tuckedAt: at })
  expect(await s.allocateSessionLetter(iss(1))).toBe('A')

  const panel = s.panel
  await panel.save(scope, 'issuePanelTodo', {
    id: todo(1),
    issueId: iss(1),
    position: position(tag),
    text: `${tag} todo`,
    done: false,
  })
  await panel.save(scope, 'issuePanelArtifact', {
    id: artifact(1),
    issueId: iss(1),
    position: position(tag),
    path: `${tag}-artifact.png`,
    addedAt: at,
  })
  await panel.save(scope, 'issuePanelDeferred', {
    id: deferred(1),
    issueId: iss(1),
    position: position(tag),
    text: `${tag} deferred`,
    addedAt: at,
  })
  await panel.save(scope, 'issuePanelState', {
    id: iss(1),
    text: `${tag} state`,
    updatedAt: at,
  })
  await s.gitStates.set(scope, iss(2), {
    updatedAt: at,
    branch: `${tag}-issue-branch`,
    shared: false,
    dirtyFiles: tag === 'a' ? 1 : 2,
  })
}
/** An issue only `tag`'s workspace holds: top level, in the same repository, its own number. */
/** The session that started each workspace's own planted issue. */
export const STARTED_BY = asSessionId('started-by')

export async function plantOnly(store: SessionStore, tag: Tag): Promise<void> {
  await store.issues.upsertIssue(
    scope,
    // Started by a session id both workspaces hold (POD-7431's provenance read).
    issue(tag, 6, {
      id: only(tag),
      seq: tag === 'a' ? 6 : 7,
      title: `${tag} only`,
      startedBySession: STARTED_BY,
    }),
  )
}
