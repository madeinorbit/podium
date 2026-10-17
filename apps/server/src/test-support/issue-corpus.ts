/**
 * The benchmark corpus (POD-6146: cell h1a1, seed 4443) as stored issues, for
 * corpus-scale tests (first written for POD-6158's issue-map comparisons):
 * every issue with its repository, parent, stage, deferral and deletion, its
 * dependency edges (older spellings
 * folded as the fixed-types migration folds them), owners and grants spread
 * over three people so visibility is exercised.
 */

import { fileURLToPath } from 'node:url'
import { asIssueId, asMachineId, asUserId, firstAdminMemberId, ISSUE_TYPES, type UserId } from '@podium/model'
import type { IssueRow, SessionStore } from '../store'
import { issueRowFixture } from './issue-row'
import { openTestStore } from './open-test-store'

export interface CorpusIssue {
  id: string
  seq: number
  repoPath: string | null
  worktreePath: string | null
  parentId: string | null
  stage: string
  archived: boolean
  deletedAt: string | null
  priority?: number
  type?: string
  title?: string
  description?: string | null
  deferUntil?: string | null
  closedReason?: string | null
  updatedAt?: string
  ownerUserId?: string
}

export interface CorpusDep {
  fromId: string
  toId: string
  type: string
}

/** The second and third person: one sees some issues by owning or a grant,
 *  one sees almost nothing. */
export const BOB = asUserId('user:bob')
export const CAROL = asUserId('user:carol')

export async function exportedCorpus(): Promise<{ issues: CorpusIssue[]; deps: CorpusDep[]; repos: string[] }> {
  const module = fileURLToPath(new URL('../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url))
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{ issues: CorpusIssue[]; deps: CorpusDep[]; repos: string[] }>
  }
  return await exportCorpus('h1a1', 4443)
}

/** Two capital letters per repository index: AA, AB, ... */
export const prefixOf = (index: number) =>
  String.fromCharCode(65 + (Math.floor(index / 26) % 26)) + String.fromCharCode(65 + (index % 26))

export function rowOf(issue: CorpusIssue, repoPath: string, machineId: string): IssueRow {
  const owner = issue.ownerUserId ?? firstAdminMemberId()
  return {
    ...issueRowFixture({
      id: issue.id,
      repoPath,
      seq: issue.seq,
      ownerUserId: owner,
      createdByActor: owner,
      createdByOnBehalfOf: owner,
    }),
    repoId: undefined,
    machineId: asMachineId(machineId),
    parentId: issue.parentId ? asIssueId(issue.parentId) : null,
    worktreePath: issue.worktreePath,
    branch: issue.worktreePath ? `issue/${issue.seq}` : null,
    stage: issue.stage as IssueRow['stage'],
    archived: issue.archived,
    deletedAt: issue.deletedAt,
    priority: issue.priority ?? 2,
    // Retired corpus types (epic, bug, ...) are tasks now (POD-6106).
    type: (ISSUE_TYPES.includes(issue.type as never) ? issue.type : 'task') as IssueRow['type'],
    title: issue.title ?? `Issue ${issue.seq}`,
    description: issue.description ?? '',
    deferUntil: issue.deferUntil ?? null,
    closedReason: issue.closedReason ?? null,
    ...(issue.updatedAt ? { updatedAt: issue.updatedAt, createdAt: issue.updatedAt } : {}),
    revision: undefined,
  } as IssueRow
}

/** The corpus's dependency types, folded onto the fixed list; others dropped. */
export function foldedDeps(deps: readonly CorpusDep[], ids: ReadonlySet<string>): CorpusDep[] {
  const folded: Readonly<Record<string, string>> = {
    blocks: 'blocked-by', 'waits-on': 'blocked-by', duplicate: 'duplicates',
    tracks: 'related', 'caused-by': 'related', validates: 'related',
  }
  const types = new Set(['blocked-by', 'related', 'discovered-from', 'supersedes', 'duplicates'])
  return deps
    .map((dep) => ({ ...dep, type: folded[dep.type] ?? dep.type }))
    .filter((dep) => ids.has(dep.fromId) && ids.has(dep.toId) && types.has(dep.type))
}

/**
 * A test store holding these issues: repositories registered with prefixes,
 * rows written first and parent links second (a foreign key), then the edges.
 */
export async function seededStore(
  issues: readonly CorpusIssue[],
  repos: readonly string[],
  deps: readonly CorpusDep[] = [],
): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  await store.transact(async () => {
    for (const [index, path] of repos.entries()) {
      await store.repos.addRepo(path, store.hostMachineId, undefined, prefixOf(index))
    }
  })
  for (let start = 0; start < issues.length; start += 500) {
    await store.transact(async () => {
      for (const issue of issues.slice(start, start + 500)) {
        await store.issues.upsertIssue(
          rowOf({ ...issue, parentId: null }, issue.repoPath ?? repos[0]!, store.hostMachineId),
        )
      }
    })
  }
  const ids = new Set(issues.map((issue) => issue.id))
  await store.transact(async () => {
    for (const issue of issues) {
      if (!issue.parentId || !ids.has(issue.parentId)) continue
      const row = (await store.issues.getIssue(issue.id))!
      row.parentId = asIssueId(issue.parentId)
      await store.issues.upsertIssue(row)
    }
  })
  await store.transact(async () => {
    for (const dep of deps) await store.issues.addIssueDep(asIssueId(dep.fromId), asIssueId(dep.toId), dep.type)
  })
  return store
}

/** Grant `grantee` a verb on an issue owned by the first admin. */
export async function grantIssue(store: SessionStore, issueId: string, grantee: UserId, verb: 'read' | 'write' | 'see' | 'use' | 'manage') {
  const owner = await firstAdminMemberId(store)
  await store.grants.upsert({
    resourceKind: 'issue',
    resourceId: issueId,
    grantee,
    verb,
    owner,
    visibility: 'personal',
    createdAt: '2026-10-01T00:00:00Z',
    actorKind: 'user',
    actorId: owner,
    onBehalfOf: owner,
  })
}

/** SQL straight to the store's connection, for rows no repository writes. */
export function rawSql(store: SessionStore, statement: string, ...args: unknown[]): void {
  ;(store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
    .prepare(statement)
    .run(...args)
}
