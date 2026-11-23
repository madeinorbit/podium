/**
 * `build(ids)` RUNS A FIXED NUMBER OF STATEMENTS (POD-6763, server-data
 * rule 8): building 5 or 200 issues with their labels, or their dependency
 * edges, is the same reads, one per table.
 */
import {
  asIssueId,
  asMachineId,
  asUserId,
  firstAdminMemberId,
  issueDepId,
  machineAccessRowId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, it } from 'vitest'
import type { IssueRow, SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../test-support/statement-count'
import { type RecordReads, serverRecordBuilders } from './record-builders'

interface Fixture {
  store: SessionStore
  reads: RecordReads
  ids: string[]
  depIds: string[]
  machineIds: string[]
  accessIds: string[]
}

const registry = serverRecordBuilders()
const reader = asUserId('reader')

/** An issue row with no references to other rows (as `registry.statement-count.test.ts`). */
function row(seq: number, patch: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId(`iss_${seq}`),
    repoPath: '/repo',
    seq,
    title: `Issue ${seq}`,
    description: '',
    ownerUserId: reader,
    visibility: 'personal',
    createdByActor: firstAdminMemberId(),
    createdByOnBehalfOf: null,
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    acceptance: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    archived: false,
    ...patch,
  }
}

async function world(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
  const ids: string[] = []
  for (let i = 1; i <= size; i++) {
    const id = asIssueId(`iss_${i}`)
    await store.issues.upsertIssue(fixtureWriteScope(), row(i))
    await store.issues.setIssueLabels(id, ['bug'])
    ids.push(id)
  }
  const machineIds: string[] = []
  const accessIds: string[] = []
  const owner = await firstAdminMemberId(store)
  for (let i = 1; i <= size; i++) {
    const id = asMachineId(`machine-${i}`)
    await store.machines.upsertMachine({
      id,
      name: id,
      hostname: 'host',
      tokenHash: 'test',
      ownerUserId: owner,
      assignment: { server: false, agentExecution: true },
    })
    machineIds.push(id)
    accessIds.push(machineAccessRowId(owner, id))
    await store.issues.gitStates.set(fixtureWriteScope(), ids[i - 1]!, {
      updatedAt: '2026-11-10T00:00:00.000Z',
      branch: 'branch',
      shared: false,
      dirtyFiles: 1,
    })
  }
  await store.conversations.registry.ensureMany(
    store.hostMachineId,
    ids.map((id) => ({ nativeId: id, providerId: 'claude-code' })),
  )
  await store.conversations.index.upsert(
    fixtureWriteScope(),
    ids.map((id) => ({
      id,
      agentKind: 'claude-code',
      providerId: 'claude-code',
      machineId: store.hostMachineId,
    })),
  )
  const depIds: string[] = []
  for (let i = 1; i < size; i++) {
    await store.issues.addIssueDep(asIssueId(`iss_${i + 1}`), asIssueId(`iss_${i}`))
    depIds.push(issueDepId(`iss_${i + 1}`, `iss_${i}`, 'blocked-by'))
  }
  const reads: RecordReads = {
    store,
    effectExecutors: { get: () => undefined },
    now: Date.now,
  }
  return { store, reads, ids, depIds, machineIds, accessIds }
}

const issueProjectionPin: StatementPin<Fixture> = {
  name: 'build(issueProjection ids)',
  setup: world,
  target: (f) => f.store,
  run: async (f) => await registry.build(f.reads, 'issueProjection', f.ids),
  check: (result, _f, size) => {
    if ((result as unknown[]).length !== size)
      throw new Error(`built ${(result as unknown[]).length} of ${size}`)
  },
  teardown: async (f) => await f.store.close(),
}

const issueDepPin: StatementPin<Fixture> = {
  name: 'build(issueDep ids)',
  setup: world,
  target: (f) => f.store,
  run: async (f) => await registry.build(f.reads, 'issueDep', f.depIds),
  check: (result, _f, size) => {
    if ((result as unknown[]).length !== size - 1)
      throw new Error(`built ${(result as unknown[]).length} of ${size - 1}`)
  },
  teardown: async (f) => await f.store.close(),
}

describe('record builders: statement counts (POD-6763)', () => {
  it('builds issue projections in one read per table, whatever the number', async () => {
    await expectConstantStatements(issueProjectionPin, 2)
  })

  it('the issue projection pin is armed', async () => {
    await expectArmed(issueProjectionPin, 2, (f) => {
      const original = f.store.issues.labelsOfIssues.bind(f.store.issues)
      f.store.issues.labelsOfIssues = async (ids) => {
        for (const id of ids) await f.store.issues.getIssue(id)
        return await original(ids)
      }
      return () => {
        f.store.issues.labelsOfIssues = original
      }
    })
  })

  it('builds dependency edges in one read', async () => {
    await expectConstantStatements(issueDepPin, 1)
  })
})

for (const [kind, count, keys] of [
  ['conversation', 1, 'ids'],
  ['issueGitState', 1, 'ids'],
  ['machine', 3, 'machineIds'],
  ['machineAccess', 4, 'accessIds'],
] as const) {
  it(`builds ${kind} in ${count} statements at 5 and 200 records`, async () => {
    await expectConstantStatements(
      {
        name: `build(${kind})`,
        setup: world,
        target: (f) => f.store,
        run: async (f) => await registry.build(f.reads, kind, f[keys]),
        check: (result, _f, size) => {
          if ((result as unknown[]).length !== size) throw new Error(`missing ${kind} records`)
        },
        teardown: async (f) => await f.store.close(),
      },
      count,
    )
  })
}
