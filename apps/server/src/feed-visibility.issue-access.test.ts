/**
 * THE NARROW ISSUE READ DECIDES WHAT THE FULL ROW DECIDED (POD-7153).
 *
 * The visibility pass reads only what the sharing rules use of an issue
 * (`loadIssueAccess`: the execution pointers and the checkout path), not the
 * whole row with its bodies. On the same fixtures, a pass over the narrow read
 * and a pass over the full-row read (the port without `loadIssueAccess`, which
 * is how the pass read before) must grant, deny and shape every ref alike, for
 * every reader.
 */

import {
  actorUser,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  issueEventRowId,
  issueUserStateRowId,
  type UserId,
} from '@podium/model'
import {
  asCapabilityRef,
  asDeviceId,
  type MetadataEntityKind,
  type Principal,
} from '@podium/protocol'
import {
  type EntityRef,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
  shapedValue,
} from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore } from './hot-path-ports'
import type { SessionStore } from './store'
import type { SessionRow } from './store/types'
import { issueRowFixture } from './test-support/issue-row'
import { openTestStore } from './test-support/open-test-store'
import { testStoreRecords } from './test-support/record-writer'

const other = asUserId('mem_other')
let store: SessionStore
let owner: UserId

const session = (id: string, ownerUserId: UserId): SessionRow =>
  ({
    id: asSessionId(id),
    ownerUserId,
    agentKind: 'codex',
    cwd: '/workspace',
    title: id,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: '2026-11-01T00:00:00.000Z',
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: asMachineId(store.hostMachineId),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: 'user',
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
    createdBy: { actor: actorUser(ownerUserId), onBehalfOf: ownerUserId },
  }) as SessionRow

/** Issues across the fields the rules read: owners, homes, checkouts and every pointer. */
const ISSUES = () => [
  { id: 'iss_plain', ownerUserId: owner, machineId: null, worktreePath: null },
  {
    id: 'iss_own_execution',
    ownerUserId: owner,
    machineId: store.hostMachineId,
    worktreePath: '/repo/.worktrees/own',
    coordinatorSessionId: 'ses_owner',
    startedBySession: 'ses_owner',
    humanQuestionAskedBy: 'ses_owner',
  },
  {
    id: 'iss_other_execution',
    ownerUserId: other,
    machineId: store.hostMachineId,
    worktreePath: '/repo/.worktrees/other',
    coordinatorSessionId: 'ses_other',
    startedBySession: 'ses_other',
    humanQuestionAskedBy: 'ses_other',
  },
  {
    id: 'iss_unknown_sessions',
    ownerUserId: other,
    machineId: 'mach_elsewhere',
    worktreePath: '/elsewhere',
    coordinatorSessionId: 'ses_gone',
    startedBySession: 'ses_gone',
    humanQuestionAskedBy: null,
  },
  { id: 'iss_deleted', ownerUserId: owner, deletedAt: '2026-11-02T00:00:00.000Z' },
]

beforeAll(async () => {
  store = await openTestStore(':memory:')
  owner = await firstAdminMemberId(store)
  await store.sessions.upsertSession(fixtureWriteScope(), session('ses_owner', owner))
  await store.sessions.upsertSession(fixtureWriteScope(), session('ses_other', other))
  for (const [at, issue] of ISSUES().entries()) {
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRowFixture({
        seq: at + 1,
        parentId: null,
        archived: false,
        closedReason: null,
        ...issue,
      }),
    )
  }
})
afterAll(async () => await store.close())

/** The store with the issue port the pass had before: full rows only. */
function fullRowStore(): FeedVisibilityStore {
  const issues = store.issues
  const port: FeedVisibilityStore['issues'] &
    Pick<SessionStore['issues'], 'loadIssue' | 'loadIssues'> = {
    getIssue: (id) => issues.getIssue(id),
    getIssues: (ids) => issues.getIssues(ids),
    loadIssue: (id) => issues.loadIssue(id),
    loadIssues: (ids) => issues.loadIssues(ids),
    liveWorktreeIssuesOnMachines: (ids) => issues.liveWorktreeIssuesOnMachines(ids),
    panel: issues.panel,
    depsFromIssues: (ids) => issues.depsFromIssues(ids),
  }
  return new Proxy(store, {
    get: (target, key) => (key === 'issues' ? port : Reflect.get(target, key, target)),
  }) as unknown as FeedVisibilityStore
}

function policyOver(rows: FeedVisibilityStore) {
  const visibility = makeFeedVisibility({
    store: rows,
    audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
    authorizationRevision: () => store.grants.visibilityRevision(),
    currentRecords: testStoreRecords(store).build,
  })
  return new GrantEdgeVisibilityPolicy(visibility.state, new NoDelegationsGranted())
}

const principal = (user: UserId): Principal => ({
  kind: 'user',
  user,
  device: asDeviceId('dev_parity'),
  capability: asCapabilityRef('cap_parity'),
})

/** Every issue-keyed ref the pass decides from the issue row, and one for no issue. */
function refsOf(): EntityRef[] {
  const ids = [...ISSUES().map((issue) => issue.id), 'iss_absent']
  return ids.flatMap((id): EntityRef[] => [
    { entity: 'issueProjection', entityId: id },
    { entity: 'issueDescription', entityId: id },
    { entity: 'issueBrief', entityId: id },
    { entity: 'issueGitState', entityId: id },
    { entity: 'issueUserState', entityId: issueUserStateRowId(owner, asIssueId(id)) },
    { entity: 'issueUserState', entityId: issueUserStateRowId(other, asIssueId(id)) },
    { entity: 'issueEvent', entityId: issueEventRowId(1, id) },
  ])
}

/** The value a ref is shaped from: its built record, or one that carries every private field. */
async function recordValueOf(ref: EntityRef): Promise<unknown> {
  const [built] = await testStoreRecords(store).build(ref.entity as MetadataEntityKind, [
    ref.entityId,
  ])
  if (built !== undefined) return built.value
  return ref.entity === 'issueEvent'
    ? { kind: 'issue.started', payload: { worktreePath: '/w', sessionId: 'ses_other' } }
    : { id: ref.entityId, worktreePath: '/w', machineId: 'mach', coordinatorSessionId: 'ses_other' }
}

describe('the visibility pass over the narrow issue read (POD-7153)', () => {
  it('grants, denies and shapes every ref as the full-row read does, for every reader', async () => {
    const refs = refsOf()
    const access = vi.spyOn(store.issues, 'loadIssueAccess')
    const narrow = await policyOver(store).forBootstrap(refs)
    expect(access).toHaveBeenCalled()
    access.mockClear()
    const full = await policyOver(fullRowStore()).forBootstrap(refs)
    expect(access).not.toHaveBeenCalled()
    access.mockRestore()
    let granted = 0
    let denied = 0
    for (const user of [owner, other, asUserId('mem_stranger')]) {
      for (const ref of refs) {
        const who = principal(user)
        const visible = narrow.decide(who, ref).visible
        expect(visible, `${user} ${ref.entity} ${ref.entityId}`).toBe(full.decide(who, ref).visible)
        if (!visible) {
          denied++
          continue
        }
        granted++
        const value = await recordValueOf(ref)
        expect(
          shapedValue(narrow, who, ref, value),
          `${user} ${ref.entity} ${ref.entityId}`,
        ).toEqual(shapedValue(full, who, ref, value))
      }
    }
    // The fixtures reach both answers.
    expect(granted).toBeGreaterThan(0)
    expect(denied).toBeGreaterThan(0)
  })

  it('reads no issue body', async () => {
    const rows = await store.issues.loadIssueAccess(ISSUES().map((issue) => issue.id))
    expect([...rows.keys()].sort()).toEqual(
      [...(await store.issues.loadIssues(ISSUES().map((issue) => issue.id))).keys()].sort(),
    )
    for (const row of rows.values()) {
      expect(Object.keys(row).sort()).toEqual([
        'coordinatorSessionId',
        'humanQuestionAskedBy',
        'id',
        'machineId',
        'ownerUserId',
        'startedBySession',
        'worktreePath',
      ])
    }
  })
})
