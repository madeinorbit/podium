/**
 * POD-4695 — the shared repo-from-lane composer: the takeover rule, pinned,
 * and the guard that neither arm keeps a local composition.
 *
 * Part A drives the shared composer through fake slot writes with an
 * engine-like members index (a lane join maintains `repo.worktrees`, a lane
 * leave removes it before the takeover reads the collection). Part B pins,
 * by module graph (not by spelling: `harness/entry-pin`), that both arms'
 * `pool/tables.ts` — and both field layers — reach this module, and that no
 * arm defines its own composition. A planted local composition in one arm
 * (definitions back in `tables.ts`, import removed) fails Part B red.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createPlainTables as createMobxPlainTables,
  ingestOut as mobxIngestOut,
  ingestRecord as mobxIngestRecord,
} from '@podium/client-graph/tables'
import type { RelationMaintenance as MobxMaintenance } from '@podium/client-graph/relations'
import { moduleGraphOf } from '../../harness/entry-pin'
import {
  FEED_SPELLING,
  ingestWorktreeRecord,
  isLaneRow,
  laneRepoId,
  repoFieldOf,
  repoLaneCalls,
  resetRepoLaneCalls,
  type RepoLaneOps,
} from '@podium/client-graph/shared/repo-from-lane'
import type { RowRecord } from './stats'

const PACKAGE_DIR = process.cwd().endsWith(join('tests', 'worklist'))
  ? process.cwd()
  : join(process.cwd(), 'tests', 'worklist')
const SHARED_COMPOSER = resolve(PACKAGE_DIR, '../../packages/client-graph/src/shared/repo-from-lane.ts')

// ------------------------------------------------------------------ fakes

interface FakeTables {
  worktree: Map<string, object>
  repo: Map<string, object>
}

/** Slot writes plus an engine-like `repo.worktrees` index over the lanes. */
function fakeOps(tables: FakeTables, requireRelations = false): RepoLaneOps & { calls: string[] } {
  const calls: string[] = []
  const membersOf = (repoId: string): string[] => {
    const out: string[] = []
    for (const [path, row] of tables.worktree) {
      if (laneRepoId(row) === repoId) out.push(path)
    }
    return out.sort()
  }
  return {
    calls,
    getWorktree: (id) => tables.worktree.get(id),
    getRepo: (id) => tables.repo.get(id),
    putWorktree: (id, row) => {
      calls.push(`put worktree ${id}`)
      tables.worktree.set(id, row)
    },
    putRepo: (id, row) => {
      calls.push(`put repo ${id}`)
      tables.repo.set(id, row)
    },
    dropWorktree: (id) => {
      calls.push(`drop worktree ${id}`)
      tables.worktree.delete(id)
    },
    dropRepo: (id) => {
      calls.push(`drop repo ${id}`)
      tables.repo.delete(id)
    },
    // The engine maintains the collection on the same slot write, so derive
    // it from the lanes: by the time the takeover reads it, the leaving lane
    // has already left the worktree table.
    repoWorktreeMembers: (repoId) => membersOf(repoId),
    requireRelations,
  }
}

const lane = (path: string, repoId: string | null, extra: object = {}): object => ({
  path,
  ...(repoId !== null ? { repoId } : {}),
  repoPath: '/repo',
  repoName: 'repo',
  ...extra,
})
const rawRepo = (extra: object = {}): object => ({ id: 'r1', prefix: 'POD', ...extra })

// ------------------------------------------------------------------ Part A

describe('repo-from-lane composition', () => {
  it('a lane carrying a repoId is the repo row; the holder stays while repo facts are equal', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    const first = lane('/repo', 'r1')
    const second = lane('/repo/wt', 'r1')
    ingestWorktreeRecord(ops, '/repo', first)
    expect(tables.repo.get('r1')).toBe(first)
    // POD-5423 finding 12: the same repo facts (repoId, repoPath, repoName,
    // prefix) keep the holder, so a lane-only change wakes no repo reader.
    ingestWorktreeRecord(ops, '/repo/wt', second)
    expect(tables.repo.get('r1')).toBe(first)
    expect(tables.worktree.get('/repo')).toBe(first)
    // A lane with different repo facts still replaces the holder.
    const renewed = lane('/repo/wt', 'r1', { prefix: 'NEW' })
    ingestWorktreeRecord(ops, '/repo/wt', renewed)
    expect(tables.repo.get('r1')).toBe(renewed)
  })

  it('takeover: the holding lane leaves and another lane of the repo takes over', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    const first = lane('/repo', 'r1')
    const second = lane('/repo/wt', 'r1')
    ingestWorktreeRecord(ops, '/repo', first)
    ingestWorktreeRecord(ops, '/repo/wt', second)
    // POD-5423 finding 12: the holder stays while the repo facts are equal.
    expect(tables.repo.get('r1')).toBe(first)
    // The holding lane leaves: the repo row becomes the remaining lane, and
    // the repo itself is never dropped in between.
    ingestWorktreeRecord(ops, '/repo', undefined)
    expect(tables.worktree.has('/repo')).toBe(false)
    expect(tables.worktree.get('/repo/wt')).toBe(second)
    expect(tables.repo.get('r1')).toBe(second)
    expect(ops.calls).not.toContain('drop repo r1')
  })

  it('the repo leaves with its last lane', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    ingestWorktreeRecord(ops, '/repo', lane('/repo', 'r1'))
    ingestWorktreeRecord(ops, '/repo/wt', lane('/repo/wt', 'r1'))
    ingestWorktreeRecord(ops, '/repo', undefined)
    expect(tables.repo.get('r1')).toBeDefined()
    ingestWorktreeRecord(ops, '/repo/wt', undefined)
    expect(tables.repo.has('r1')).toBe(false)
  })

  it('a lane moving to another repo hands its old repo over', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    const keeper = lane('/repo', 'r1')
    const moved = lane('/repo/wt', 'r1')
    ingestWorktreeRecord(ops, '/repo', keeper)
    ingestWorktreeRecord(ops, '/repo/wt', moved)
    // POD-5423 finding 12: the keeper holds while the repo facts are equal.
    expect(tables.repo.get('r1')).toBe(keeper)
    const movedToR2 = lane('/repo/wt', 'r2')
    ingestWorktreeRecord(ops, '/repo/wt', movedToR2)
    expect(tables.repo.get('r1')).toBe(keeper)
    expect(tables.repo.get('r2')).toBe(movedToR2)
  })

  it('the raw replicated row is held until a lane arrives and never replaces one', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    const raw = rawRepo()
    ingestWorktreeRecord(ops, 'r1', raw)
    expect(tables.repo.get('r1')).toBe(raw)
    const first = lane('/repo', 'r1')
    ingestWorktreeRecord(ops, '/repo', first)
    expect(tables.repo.get('r1')).toBe(first)
    // A raw row arriving while a lane holds the repo is ignored.
    ingestWorktreeRecord(ops, 'r1', rawRepo({ prefix: 'NEW' }))
    expect(tables.repo.get('r1')).toBe(first)
    // The raw row leaving while a lane holds the repo changes nothing.
    ingestWorktreeRecord(ops, 'r1', undefined)
    expect(tables.repo.get('r1')).toBe(first)
  })

  it('the raw row leaving with no lane held drops the repo', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    ingestWorktreeRecord(ops, 'r1', rawRepo())
    ingestWorktreeRecord(ops, 'r1', undefined)
    expect(tables.repo.has('r1')).toBe(false)
  })

  it('a lane without a repoId is only a worktree row', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    // No `repoId` at all, and an empty one: neither names a repo.
    ingestWorktreeRecord(ops, '/lonely', { path: '/lonely', repoPath: '/lonely' })
    ingestWorktreeRecord(ops, '/empty', { path: '/empty', repoId: '', repoPath: '/empty' })
    expect(tables.worktree.size).toBe(2)
    expect(tables.repo.size).toBe(0)
    expect(laneRepoId({ path: '/x' })).toBe(null)
    expect(laneRepoId({ path: '/x', repoId: '' })).toBe(null)
    expect(isLaneRow({ id: 'r1' })).toBe(false)
  })

  it('FEED_SPELLING routes repo.path to the lane repoPath', () => {
    expect(FEED_SPELLING.repo).toEqual({ path: 'repoPath' })
    expect(repoFieldOf(lane('/repo', 'r1'), 'path')).toBe('/repo')
    expect(repoFieldOf(rawRepo(), 'prefix')).toBe('POD')
  })

  it('without relations the mobx policy drops and the hand policy throws', () => {
    const mobxTables: FakeTables = { worktree: new Map(), repo: new Map() }
    const mobx = fakeOps(mobxTables)
    mobx.repoWorktreeMembers = () => undefined
    ingestWorktreeRecord(mobx, '/repo', lane('/repo', 'r1'))
    expect(mobxTables.repo.has('r1')).toBe(true)
    // The holding lane leaves with no relations to ask: the repo leaves.
    ingestWorktreeRecord(mobx, '/repo', undefined)
    expect(mobxTables.repo.has('r1')).toBe(false)

    const handTables: FakeTables = { worktree: new Map(), repo: new Map() }
    const hand = fakeOps(handTables, true)
    hand.repoWorktreeMembers = () => undefined
    ingestWorktreeRecord(hand, '/repo', lane('/repo', 'r1'))
    expect(() => ingestWorktreeRecord(hand, '/repo', undefined)).toThrow(/keeps no relations/)
  })
})

// ------------------------------------------------------------------ Part B

const ARM_TABLES = [
  resolve(PACKAGE_DIR, '../../packages/client-graph/src/tables.ts'),
]
const FIELD_LAYERS = [
  resolve(PACKAGE_DIR, '../../packages/client-graph/src/models.ts'),
]

function codeOf(file: string): string {
  return readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

describe('both arms consume the shared composer', () => {
  it('each arm tables.ts reaches the shared composer by module, however spelled', () => {
    for (const tables of ARM_TABLES) {
      const graph = moduleGraphOf(tables)
      expect(graph, `${tables} reaches shared/src/repo-from-lane.ts`).toContain(SHARED_COMPOSER)
    }
  })

  it('each field layer reaches the shared spelling by module', () => {
    for (const layer of FIELD_LAYERS) {
      const graph = moduleGraphOf(layer)
      expect(graph, `${layer} reaches shared/src/repo-from-lane.ts`).toContain(SHARED_COMPOSER)
    }
  })

  it('no arm defines its own lane composition', () => {
    const definitions = [
      /function\s+isLane\s*\(/,
      /function\s+laneRepoId\s*\(/,
      /function\s+releaseRepo\s*\(/,
      /function\s+ingestWorktree\s*\(/,
      /(export\s+)?const\s+FEED_SPELLING\s*=/,
    ]
    for (const file of [...ARM_TABLES, ...FIELD_LAYERS]) {
      const code = codeOf(file)
      for (const pattern of definitions) {
        expect(code, `${file} keeps no local ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('no arm tables.ts reads lane fields except through the shared composer', () => {
    for (const tables of ARM_TABLES) {
      const code = codeOf(tables)
      // POD-5423 finding 12: the product's single row reader declares its
      // facade inputs (RepoInputs) and reads them via the shared composer's
      // repoFieldOf/FEED_SPELLING. A direct lane read off the feed row would
      // bypass that spelling, so every repoPath line must be one of those
      // mediated uses.
      const lanes = code.split('\n').filter((line) => line.includes('repoPath'))
      expect(lanes.length, `${tables} declares its repo facade through the shared spelling`).toBeGreaterThan(0)
      for (const line of lanes) {
        expect(line, `${tables} reads no lane field itself: ${line.trim()}`).toMatch(
          /RepoInputs|repoFieldOf|\['id',\s*'prefix',\s*'repoPath'\]/,
        )
      }
    }
  })
})

// ------------------------------------------------------------------ Part C

/**
 * Behavioural consumption pin (POD-4695 addendum 2): every worktree record
 * an arm ingests must pass through the shared composer. A renamed local
 * copy produces the same table contents, so contents are asserted too but
 * the COUNT is what tells delegation apart from duplication: the plant
 * keeps the import alive (`void ingestWorktreeRecord`) yet never calls it.
 */
function liveWorktreeMembers(worktree: Map<string, object>) {
  return {
    changed: () => {},
    members: (from: string, id: string, relation: string): Set<string> => {
      if (from !== 'repo' || relation !== 'worktrees') {
        throw new Error(`unexpected collection ${from}.${relation}`)
      }
      const out = new Set<string>()
      for (const [path, row] of worktree) if (laneRepoId(row) === id) out.add(path)
      return out
    },
  }
}

const worktreeRecord = (id: string, value: object | undefined): RowRecord => ({
  kind: 'worktree',
  id,
  value: value as RowRecord['value'],
})

/**
 * Join, holder-stays-while-facts-equal, takeover, move, raw-row hold,
 * last-leave, repo-less lane, plus one issue record the composer must ignore.
 * Returns the lane objects for identity assertions.
 */
function laneScript() {
  const a = lane('/repo', 'r1')
  const b = lane('/repo/wt', 'r1')
  const aMoved = lane('/repo', 'r2')
  const raw = { id: 'r3', prefix: 'POD' }
  const c = lane('/r3', 'r3')
  const lonely = { path: '/lonely', repoPath: '/lonely' }
  const records: RowRecord[] = [
    worktreeRecord('/repo', a),
    worktreeRecord('/repo/wt', b),
    { kind: 'issue', id: 'i1', value: { id: 'i1' } as RowRecord['value'] },
    worktreeRecord('/repo/wt', undefined),
    worktreeRecord('/repo', aMoved),
    worktreeRecord('r3', raw),
    worktreeRecord('/r3', c),
    worktreeRecord('r3', { id: 'r3', prefix: 'NEW' }),
    worktreeRecord('r3', undefined),
    worktreeRecord('/r3', undefined),
    worktreeRecord('/lonely', lonely),
  ]
  return { records, a, b, aMoved, raw, c, lonely, worktreeRecords: 10 }
}

function expectScriptedHoldings(
  repo: Map<string, object>,
  worktree: Map<string, object>,
  script: ReturnType<typeof laneScript>,
): void {
  expect(repo.get('r1')).toBeUndefined()
  expect(repo.get('r2')).toBe(script.aMoved)
  expect(repo.get('r3')).toBeUndefined()
  expect(repo.size).toBe(1)
  expect(worktree.get('/repo')).toBe(script.aMoved)
  expect(worktree.get('/lonely')).toBe(script.lonely)
  expect(worktree.has('/repo/wt')).toBe(false)
  expect(worktree.has('/r3')).toBe(false)
}

describe('every worktree record passes through the shared composer', () => {
  it('mobx ingestRecord routes each worktree record through it', () => {
    const script = laneScript()
    const tables = createMobxPlainTables()
    const target = {
      read: tables,
      write: tables,
      relations: liveWorktreeMembers(
        tables.worktree as Map<string, object>,
      ) as unknown as MobxMaintenance,
    }
    const out = mobxIngestOut()
    const repo = target.write.repo as Map<string, object>
    resetRepoLaneCalls()
    const [w1, w2, issue, w3, ...rest] = script.records
    mobxIngestRecord(target, w1!, out)
    mobxIngestRecord(target, w2!, out)
    // POD-5423 finding 12: w2 carries the same repo facts, so the holder stays.
    expect(repo.get('r1')).toBe(script.a)
    mobxIngestRecord(target, issue!, out)
    expect(repoLaneCalls.worktreeRecords).toBe(2)
    mobxIngestRecord(target, w3!, out)
    expect(repo.get('r1')).toBe(script.a)
    for (const record of rest) mobxIngestRecord(target, record, out)
    expect(repoLaneCalls.worktreeRecords).toBe(script.worktreeRecords)
    expectScriptedHoldings(
      repo,
      target.write.worktree as Map<string, object>,
      script,
    )
  })

})
