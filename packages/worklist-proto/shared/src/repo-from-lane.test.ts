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
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moduleGraphOf } from '../../harness/entry-pin'
import {
  FEED_SPELLING,
  ingestWorktreeRecord,
  isLaneRow,
  laneRepoId,
  repoFieldOf,
  type RepoLaneOps,
} from './repo-from-lane'

const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const SHARED_COMPOSER = join(PACKAGE_DIR, 'shared', 'src', 'repo-from-lane.ts')

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
  it('a lane carrying a repoId is the repo row; the latest lane wins', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    const first = lane('/repo', 'r1')
    const second = lane('/repo/wt', 'r1')
    ingestWorktreeRecord(ops, '/repo', first)
    expect(tables.repo.get('r1')).toBe(first)
    ingestWorktreeRecord(ops, '/repo/wt', second)
    expect(tables.repo.get('r1')).toBe(second)
    expect(tables.worktree.get('/repo')).toBe(first)
  })

  it('takeover: the holding lane leaves and another lane of the repo takes over', () => {
    const tables: FakeTables = { worktree: new Map(), repo: new Map() }
    const ops = fakeOps(tables)
    const first = lane('/repo', 'r1')
    const second = lane('/repo/wt', 'r1')
    ingestWorktreeRecord(ops, '/repo', first)
    ingestWorktreeRecord(ops, '/repo/wt', second)
    expect(tables.repo.get('r1')).toBe(second)
    // The holding lane leaves: the repo row becomes the remaining lane, and
    // the repo itself is never dropped in between.
    ingestWorktreeRecord(ops, '/repo/wt', undefined)
    expect(tables.worktree.has('/repo/wt')).toBe(false)
    expect(tables.repo.get('r1')).toBe(first)
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
    expect(tables.repo.get('r1')).toBe(moved)
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
    const first = lane('/repo', 'r1')
    ingestWorktreeRecord(mobx, '/repo', first)
    expect(mobxTables.repo.get('r1')).toBe(first)
    ingestWorktreeRecord(mobx, '/repo', lane('/repo', 'r1', { repoName: 'moved' }))
    expect(mobxTables.repo.has('r1')).toBe(false)

    const handTables: FakeTables = { worktree: new Map(), repo: new Map() }
    const hand = fakeOps(handTables, true)
    hand.repoWorktreeMembers = () => undefined
    ingestWorktreeRecord(hand, '/repo', lane('/repo', 'r1'))
    expect(() =>
      ingestWorktreeRecord(hand, '/repo', lane('/repo', 'r1', { repoName: 'moved' })),
    ).toThrow(/keeps no relations/)
  })
})

// ------------------------------------------------------------------ Part B

const ARM_TABLES = [
  join(PACKAGE_DIR, 'arms', 'mobx', 'pool', 'tables.ts'),
  join(PACKAGE_DIR, 'arms', 'hand', 'pool', 'tables.ts'),
]
const FIELD_LAYERS = [
  join(PACKAGE_DIR, 'arms', 'mobx', 'pool', 'models.ts'),
  join(PACKAGE_DIR, 'arms', 'hand', 'pool', 'records.ts'),
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

  it('no arm tables.ts reads lane fields itself', () => {
    for (const tables of ARM_TABLES) {
      const code = codeOf(tables)
      expect(code, `${tables} spells no lane field`).not.toContain('repoPath')
    }
  })
})
