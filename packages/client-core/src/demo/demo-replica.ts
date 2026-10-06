import { machinePathBasename } from '@podium/model'
/**
 * Demo mode over the kernel facade (POD-5277) — the SAME data path as real use.
 *
 * The phone's demo mode used to build a legacy TanStack replica through the
 * old constructor and seed it via `applySnapshot`: a second writer path the
 * product no longer uses, which meant the demo surface and the product surface
 * could diverge silently. Now the fixtures are ROWS in the kernel's own
 * vocabulary (`EntityRecord`s keyed by kernel entity name), and the ordinary
 * `StoreProvider` runs over a `createKernelReplica` facade projecting them —
 * the exact object the pool readers (`attachMobilePool` / `attachWorklistPool`)
 * consume in production.
 *
 * What is stubbed is only the network: a tRPC surface that answers the handful
 * of reads the fixture flows make and resolves mutations without changing the
 * world. Each app owns its stub (the `MobileTrpc` and web `Trpc` types differ);
 * the rows below are shared.
 */

import {
  asRepoId,
  asUserId,
  IssueProjection,
  issueDepId,
  issueUserStateRowId,
  type UserId,
} from '@podium/model'
import type { EntityRecord } from '@podium/sync/replica'
import { memoryStorage } from '../replica/contract'
import { createKernelReplica, createSideCache, type KernelBackedReplica } from '../replica/kernel'
import { DEMO_ISSUES, DEMO_SESSIONS } from './demo-data'

/** The demo principal. Named rather than borrowed from a real id so nothing in
 *  a demo run can land under a person's namespace. */
export const DEMO_PRINCIPAL = asUserId('demo')

const recordKey = (entity: string, entityId: string): string => `${entity}:${entityId}`

function put(
  records: Map<string, EntityRecord>,
  entity: string,
  entityId: string,
  value: unknown,
): void {
  records.set(recordKey(entity, entityId), {
    entity,
    entityId,
    value,
    provenance: { seq: 1 },
  })
}

/**
 * The demo fixtures as kernel entity rows: sessions plus the normalized issue
 * homes (projections, per-user markers, git states, repos, deps). Mirrors the
 * legacy `seedIssueFixtures` decomposition, but writes `EntityRecord`s the
 * kernel facade projects instead of TanStack snapshots.
 */
export function buildDemoEntityRecords(userId: UserId = DEMO_PRINCIPAL): EntityRecord[] {
  const records = new Map<string, EntityRecord>()
  for (const session of DEMO_SESSIONS) {
    put(records, 'session', session.sessionId, { ...session })
  }
  const repos = new Map<string, { id: string; repoPath: string; prefix?: string; name: string }>()
  for (const issue of DEMO_ISSUES) {
    const source = issue as unknown as Record<string, unknown>
    const row: Record<string, unknown> = {}
    for (const key of Object.keys(IssueProjection.shape)) {
      const value = source[key]
      if (value != null) row[key] = value
    }
    const repoId = issue.repoId ?? asRepoId(`fixture:${issue.repoPath}`)
    row.repoId = repoId
    row.description = { value: issue.description ?? '' }
    if (issue.notes !== undefined) row.notes = { value: issue.notes }
    row.intentOrigin = issue.intentOrigin
    row.isDraftVessel = issue.isDraftVessel
    put(records, 'issueProjection', issue.id, row)
    put(records, 'issueUserState', issueUserStateRowId(userId, issue.id as never), {
      userId,
      entityId: issue.id,
      readAt: issue.readAt ?? null,
      tuckedAt: issue.tuckedAt ?? null,
      pinned: issue.pinned ?? false,
    })
    if (issue.gitState) put(records, 'issueGitState', issue.id, { ...issue.gitState, id: issue.id })
    const prefix =
      issue.prefix ?? issue.displayRef?.match(/^([A-Z][A-Z0-9]*)-/)?.[1]
    repos.set(repoId, {
      id: repoId,
      repoPath: issue.repoPath,
      ...(prefix === undefined ? {} : { prefix }),
      name: machinePathBasename(issue.repoPath) ?? issue.repoPath,
    })
    for (const dep of issue.deps ?? []) {
      const id = issueDepId(issue.id, dep.id, dep.type)
      put(records, 'issueDep', id, {
        id,
        fromId: issue.id,
        toId: dep.id,
        type: dep.type,
      })
    }
  }
  for (const repo of repos.values()) put(records, 'repo', repo.id, repo)
  return [...records.values()]
}

/**
 * A fresh in-memory kernel-backed replica seeded with the demo fixtures. One
 * per provider mount (never shared across mounts): the facade memoises
 * projections per instance, and the side cache holds per-mount ui-state.
 *
 * The rows sit in the cache from construction, so direct reads answer
 * immediately — but the pool's question indexes (`referenceSessions`,
 * `mentionIssues`, …) build from replica EVENTS. Publish the install with
 * {@link publishDemoSlice} once the pool has attached (see below).
 */
export function createDemoReplica(): KernelBackedReplica {
  const records = new Map<string, EntityRecord>()
  for (const record of buildDemoEntityRecords()) {
    records.set(recordKey(record.entity, record.entityId), record)
  }
  return createKernelReplica({
    cache: {
      readCursor: () => null,
      readEntities: () => [...records.values()],
      read: (entity, entityId) => records.get(recordKey(entity, entityId)),
      durability: () => 'durable',
    },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
}

const DEMO_SLICE_KINDS = [
  'sessions',
  'sessionUserStates',
  'machines',
  'issueProjections',
  'issueUserStates',
  'issueGitStates',
  'issueDeps',
  'repos',
  'issueEvents',
  'pendingInteractions',
  'messageRecords',
  'shipOrders',
  'shipLanes',
  'conversations',
  'automations',
  'automationRuns',
  'userLayouts',
] as const

/**
 * Publish the seeded slice to the pool's event-fed indexes (POD-5277).
 *
 * In production these indexes fill from the bootstrap that lands AFTER the
 * pool attaches; a silently pre-seeded cache emits nothing, so the pool would
 * paint orders and summaries while every question answered empty. Call this
 * once the pool exists (its subscription strictly precedes its visibility):
 * the `bootstrap-installed` — the same signal a cold boot ends with — makes
 * the facade emit one addressed replace batch, and the row source enumerates
 * the seeded rows into a full publication. Idempotent: re-installing the
 * identical slice is absorbed without downstream churn.
 */
export function publishDemoSlice(replica: KernelBackedReplica): void {
  let entityCount = 0
  for (const kind of DEMO_SLICE_KINDS) entityCount += replica.rows(kind).length
  replica.onKernelEvent({
    type: 'bootstrap-installed',
    cause: 'cold-start',
    snapshotSeq: 1,
    entityCount,
    bufferedFramesApplied: 0,
  })
}
