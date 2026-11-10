/**
 * `issues.bodies` (POD-6767, design POD-6253 §2): the bodies the synced issue
 * record carries only headers of, read by id.
 *
 * - Each answered body names the digest its header names, so the client's
 *   cache, keyed by digest, matches the header it holds.
 * - The panel leaves as the reader may receive it: a reader who may not see
 *   the task's worktree gets its absolute artifact paths reduced, by the same
 *   rule as every command result (POD-6288).
 * - A field with no content, a missing issue and a deleted issue are absent.
 * - The statement count does not grow with the number of ids (server-data
 *   rule 8): the rows, then the machine grants and the sessions, one read each.
 */
import { asIssueId, asMachineId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import type { IssueRow, SessionStore } from '../../store'
import { OPERATOR } from '../../test-support/capabilities'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements } from '../../test-support/statement-count'
import { IssueCommandCtx } from './command-ctx'
import { readIssues } from './issue-reader'
import { issueBodiesOfRow, slimIssueProjectionOfRow } from './projection'
import { issueRegistry } from './registry'

const reader = asUserId('reader')
const other = asUserId('other')
const WORKTREE = '/repo/.worktrees/issue-1'

function row(seq: number, patch: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId(`iss_${seq}`),
    repoPath: '/repo',
    seq,
    title: `Issue ${seq}`,
    description: `The summary of issue ${seq}`,
    brief: `Brief ${seq}`,
    ownerUserId: other,
    visibility: 'personal',
    createdByActor: firstAdminMemberId(),
    createdByOnBehalfOf: null,
    stage: 'in_progress',
    worktreePath: WORKTREE,
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
    machineId: asMachineId('machine-1'),
    coordinatorSessionId: asSessionId(`ses_${seq}`),
    panel: JSON.stringify({
      todos: [],
      artifacts: [{ path: `${WORKTREE}/shot-${seq}.png`, addedAt: '2026-11-10T00:00:00.000Z' }],
      deferred: [],
    }),
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    archived: false,
    ...patch,
  }
}

interface Fixture {
  store: SessionStore
  ids: string[]
}

async function fixture(size: number, patch: (seq: number) => Partial<IssueRow> = () => ({})) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
  const rows = Array.from({ length: size }, (_, i) => row(i + 1, patch(i + 1)))
  await store.transact(async () => {
    for (const issue of rows) await store.issues.upsertIssue(fixtureWriteScope(), issue)
  })
  return { store, ids: rows.map((issue) => issue.id) } satisfies Fixture
}

const bodies = async (f: Fixture, input: { ids: string[]; fields?: string[] }) => {
  const ctx = new IssueCommandCtx(
    {
      executionFacts: {
        rows: async (ids: readonly string[]) => await readIssues(f.store.issues, ids),
        store: { grants: f.store.grants, sessions: f.store.sessions },
      },
    } as never,
    { capability: OPERATOR, principal: { kind: 'user', user: reader, capability: OPERATOR } },
    'bodies',
  )
  const handler = issueRegistry.defs.bodies.handler as (
    ctx: unknown,
    input: unknown,
  ) => Promise<unknown>
  return (await handler(ctx, input)) as {
    issueId: string
    field: string
    digest: string
    value: unknown
  }[]
}

describe('issues.bodies', () => {
  it('answers each body at the digest its header names', async () => {
    const f = await fixture(2, (seq) => (seq === 2 ? { activityNotes: 'Halfway there' } : {}))
    try {
      const answer = await bodies(f, { ids: f.ids })
      const stored = await readIssues(f.store.issues, f.ids)
      for (const id of f.ids) {
        const headers = issueBodiesOfRow(stored.get(id)!)!
        const mine = answer.filter((body) => body.issueId === id)
        // One body per header, at the header's digest; no header, no body.
        expect(Object.fromEntries(mine.map((body) => [body.field, body.digest]))).toEqual(
          Object.fromEntries(
            Object.entries(headers)
              .filter(([field]) => field !== 'id')
              .map(([field, header]) => [field, (header as { digest: string }).digest]),
          ),
        )
      }
      expect(
        answer.find((body) => body.issueId === 'iss_1' && body.field === 'activityNotes'),
      ).toBeUndefined()
      expect(
        answer.find((body) => body.issueId === 'iss_2' && body.field === 'activityNotes')?.value,
      ).toBe('Halfway there')
      expect(answer.find((body) => body.field === 'description')?.value).toEqual({
        value: 'The summary of issue 1',
      })
    } finally {
      await f.store.close()
    }
  })

  it('keeps the bodies off the synced record', async () => {
    const f = await fixture(1)
    try {
      const stored = (await readIssues(f.store.issues, f.ids)).get('iss_1')!
      const slim = slimIssueProjectionOfRow(stored, [])
      for (const field of ['brief', 'panel', 'description', 'activityNotes']) {
        expect(slim).not.toHaveProperty(field)
      }
      // A field with no content has no header.
      expect(issueBodiesOfRow(stored)).not.toHaveProperty('activityNotes')
    } finally {
      await f.store.close()
    }
  })

  it('reduces the panel for a reader who may not see the worktree', async () => {
    const f = await fixture(2, (seq) => (seq === 2 ? { ownerUserId: reader } : {}))
    try {
      const answer = await bodies(f, { ids: f.ids, fields: ['panel'] })
      const pathOf = (id: string) =>
        (answer.find((body) => body.issueId === id)?.value as { artifacts: { path: string }[] })
          .artifacts[0]!.path
      // Someone else's task: the absolute path into their worktree is gone.
      expect(pathOf('iss_1').startsWith('/')).toBe(false)
      // The reader's own task: the path is theirs to see.
      expect(pathOf('iss_2')).toBe(`${WORKTREE}/shot-2.png`)
      expect(answer.every((body) => body.field === 'panel')).toBe(true)
    } finally {
      await f.store.close()
    }
  })

  it('leaves out missing and deleted issues', async () => {
    const f = await fixture(2, (seq) =>
      seq === 2 ? { deletedAt: '2026-11-10T01:00:00.000Z' } : {},
    )
    try {
      const answer = await bodies(f, { ids: [...f.ids, 'iss_404'] })
      expect(new Set(answer.map((body) => body.issueId))).toEqual(new Set(['iss_1']))
    } finally {
      await f.store.close()
    }
  })

  it('runs the same statements for 5 and 50 issues', async () => {
    await expectConstantStatements(
      {
        name: 'issues.bodies',
        sizes: [5, 50],
        setup: (size) => fixture(size),
        target: (f) => f.store,
        run: (f) => bodies(f, { ids: f.ids }),
        check: (answer, _f, size) => expect((answer as unknown[]).length).toBe(size * 3),
        teardown: async (f) => await f.store.close(),
      },
      3,
    )
  })
})
