/**
 * The boot ref backfill reads only the sessions that can still get a birth ref
 * (POD-6222, #474).
 *
 * A ref-less session gets a ref from an existing issue or from a cwd whose repo
 * has a prefix. The rest (sessions in removed worktrees, or under a root another
 * machine registered) never do, and the backfill used to read and probe every
 * one of them on every boot. These tests pin the second boot at a constant
 * number of statements AND rows, and check that the refs, and the order they
 * are handed out in, are what the old read-everything backfill gives.
 */
import { asIssueId, asMachineId, asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { probeStatements } from '../../store/executor/statement-probe'
import type { SessionRow } from '../../store/types'
import { issueRowFixture } from '../../test-support/issue-row'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements, measureAtSizes, quietShipping, type StatementPin } from '../../test-support/statement-count'

const ROOT = '/r/podium'
const FAR_ROOT = '/r/far'
const FAR = asMachineId('mach_far')
const ISSUE = asIssueId('iss_backfill')
const MISSING_ISSUE = asIssueId('iss_never_filed')

/** What the old backfill read: every ref-less row, sorted in memory. */
const oldOrder = (a: SessionRow, b: SessionRow) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1)

/**
 * The kinds of ref-less session, by `i % 9`. Created out of id order and with
 * ties on created_at, so the allocation order is the backfill's to decide.
 */
function sessionAt(i: number, host: string): { cwd: string; machineId: string; issueId: string | null; deleted?: boolean; refDraft?: number } {
  switch (i % 9) {
    case 0: return { cwd: `/gone/issue-${i}`, machineId: host, issueId: ISSUE } // issue letter
    case 1: return { cwd: ROOT, machineId: host, issueId: null } // draft in POD
    case 2: return { cwd: `${ROOT}/packages/p${i}`, machineId: host, issueId: null } // draft in POD
    case 3: return { cwd: `${ROOT}/.worktrees/w${i}`, machineId: host, issueId: MISSING_ISSUE } // no issue: draft in POD
    case 4: return { cwd: `/gone/w${i}`, machineId: host, issueId: null } // never
    case 5: return { cwd: `${FAR_ROOT}/x${i}`, machineId: host, issueId: null } // root is another machine's: never
    case 6: return { cwd: `${FAR_ROOT}/y${i}`, machineId: FAR, issueId: null } // draft in the far repo
    case 7: return { cwd: ROOT, machineId: host, issueId: null, deleted: true } // tombstone: never
    default: return { cwd: ROOT, machineId: host, issueId: null, refDraft: 1000 + i } // already named
  }
}

interface World {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
}

async function world(size: number, extra: (store: SessionStore) => Promise<void> = async () => {}): Promise<World> {
  const store = await openTestStore(':memory:')
  const host = store.hostMachineId
  await store.repos.addRepo(ROOT, host)
  await store.repos.addRepo(FAR_ROOT, FAR)
  await extra(store)
  const owner = await firstAdminMemberId(store)
  const repoId = (await store.repos.listRepos(host)).find((r) => r.path === ROOT)!.repoId
  await store.issues.upsertIssue(issueRowFixture({
    id: ISSUE,
    ownerUserId: owner,
    createdByActor: owner,
    createdByOnBehalfOf: owner,
    repoPath: ROOT,
    repoId: repoId!,
    machineId: host,
    parentId: null,
    worktreePath: null,
    branch: null,
    blockedBy: [],
    humanQuestionAskedBy: null,
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
  }))
  const ids: SessionId[] = []
  await store.transact(async () => {
    for (let i = 0; i < size; i++) {
      const id = asSessionId(`s-${String(i).padStart(4, '0')}`)
      ids.push(id)
      const kind = sessionAt(i, host)
      await store.sessions.upsertSession({
        id,
        ownerUserId: owner,
        agentKind: 'claude-code',
        cwd: kind.cwd,
        title: `Session ${i}`,
        name: null,
        originKind: 'spawn',
        conversationId: null,
        resumeKind: null,
        resumeValue: null,
        status: 'exited',
        exitCode: 0,
        durableLabel: `podium-${id}`,
        // Later ids are older, and every third pair shares a timestamp.
        createdAt: `2026-09-01T00:${String(Math.floor((size - i) / 3) % 60).padStart(2, '0')}:00.000Z`,
        lastActiveAt: '2026-09-02T00:00:00.000Z',
        lastOutputAt: null,
        lastInputAt: null,
        lastResumedAt: null,
        archived: false,
        workState: null,
        machineId: kind.machineId,
        headless: false,
        issueId: kind.issueId,
        stoppedAt: null,
        spawnedBy: null,
        ...(kind.refDraft !== undefined ? { refDraft: kind.refDraft } : {}),
      } as never)
      if (kind.deleted) await store.sessions.softDeleteSessions([id], '2026-09-03T00:00:00.000Z', 'standalone')
    }
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await quietShipping(reg)
  return { store, reg, ids }
}

/** Every session's birth ref after the backfill, tombstones included. */
async function refs(store: SessionStore, ids: readonly SessionId[]) {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const row = await store.sessions.getSession(id)
    out[id] = `${row?.refIssueId ?? '-'}:${row?.refLetter ?? '-'}:${row?.refDraft ?? '-'}`
  }
  return out
}

/** Run the backfill the way it ran before POD-6222: read every ref-less row and
 *  sort them in memory, then ask each. */
async function backfillTheOldWay(w: World) {
  const sessions = w.store.sessions
  const everyRow = sessions.sessionsWithoutRef.bind(sessions)
  vi.spyOn(w.store.repos, 'prefixedPlaces').mockResolvedValue('everywhere')
  vi.spyOn(sessions, 'sessionsWithoutRef').mockImplementation(async () => [...(await everyRow())].sort(oldOrder))
  await w.reg.modules.sessions.repository.backfillBirthRefs()
  vi.restoreAllMocks()
}

/** Let the first boot's broadcasts and delivery triggers finish before counting
 *  (the same settle as `parked-write.statement-count.test.ts`). */
async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Session rows handed back while `fn` runs on the store's connection. */
async function rowsRead(store: SessionStore, fn: () => Promise<unknown>): Promise<number> {
  let rows = 0
  const detach = probeStatements(store as never, (observation) => {
    if (/ from "sessions"/.test(observation.sql)) rows += observation.rows
  })
  try {
    await fn()
  } finally {
    detach()
  }
  return rows
}

describe('boot ref backfill (POD-6222)', () => {
  it('hands out the same refs in the same order as reading every ref-less row', async () => {
    const before = await world(60)
    const after = await world(60)
    await backfillTheOldWay(before)
    expect(await after.store.repos.prefixedPlaces()).not.toBe('everywhere')
    await after.reg.modules.sessions.repository.backfillBirthRefs()
    const expected = await refs(before.store, before.ids)
    expect(await refs(after.store, after.ids)).toEqual(expected)
    // Not vacuous: every kind got what it should, drafts in created_at order.
    const named = Object.entries(expected).filter(([, ref]) => ref !== '-:-:-')
    for (const [id, ref] of Object.entries(expected)) {
      const kind = Number(id.slice(2)) % 9
      if (kind === 0) expect(ref).toMatch(/^iss_backfill:[A-Z]+:-$/)
      if ([1, 2, 3, 6].includes(kind)) expect(ref).toMatch(/^-:-:\d+$/)
      if ([4, 5, 7].includes(kind)) expect(ref).toBe('-:-:-')
    }
    expect(named.length).toBeGreaterThan(30)
    await before.store.close()
    await after.store.close()
  })

  it('falls back to every ref-less row when a prefix no root explains could name one, with the same refs', async () => {
    // A removed repo keeps its prefix, and a prefix can be set on an unregistered
    // path: a session sitting exactly there derives that repo id and gets a draft.
    const orphans = async (store: SessionStore) => {
      await store.repos.addRepo('/gone/w4', store.hostMachineId)
      await store.repos.removeRepo('/gone/w4', store.hostMachineId)
      await store.repos.setRepoPrefix(store.hostMachineId, '/gone/w13', 'LONE')
    }
    const before = await world(30, orphans)
    const after = await world(30, orphans)
    await backfillTheOldWay(before)
    expect(await after.store.repos.prefixedPlaces()).toBe('everywhere')
    await after.reg.modules.sessions.repository.backfillBirthRefs()
    const expected = await refs(before.store, before.ids)
    expect(await refs(after.store, after.ids)).toEqual(expected)
    expect(expected['s-0004']).toMatch(/^-:-:\d+$/)
    expect(expected['s-0013']).toMatch(/^-:-:\d+$/)
    expect(expected['s-0022']).toBe('-:-:-')
    await before.store.close()
    await after.store.close()
  })

  /** The second boot's backfill, after a first one named everything it could. */
  const secondBoot = (name: string, run: (w: World) => Promise<void>): StatementPin<World> => ({
    name,
    setup: async (size) => {
      const w = await world(size)
      await w.reg.modules.sessions.repository.backfillBirthRefs()
      await settle(w.reg)
      return w
    },
    target: (w) => w.store,
    run: async (w) => await rowsRead(w.store, () => run(w)),
    teardown: async (w) => await w.store.close(),
  })

  it('reads a constant number of statements and no rows on the second boot', async () => {
    const counts = await expectConstantStatements(
      {
        ...secondBoot('backfillBirthRefs (second boot)', (w) => w.reg.modules.sessions.repository.backfillBirthRefs()),
        check: (rows) => expect(rows, 'rows the second boot read').toBe(0),
      },
      1,
    )
    expect(counts.large.statements).toBe(1)
  })

  it('CONTROL: the read-everything backfill reads every never-named row on every boot', async () => {
    const rows: number[] = []
    await measureAtSizes({
      ...secondBoot('backfillBirthRefs the old way (second boot)', backfillTheOldWay),
      check: (read) => void rows.push(read as number),
    })
    // The never-named live sessions (kinds 4 and 5): 1 of 5 rows, 44 of 200.
    expect(rows).toEqual([1, 44])
  })
})

