import { LOADING, MobxPool } from '@podium/client-graph'
import { expect, it, vi } from 'vitest'
import { fieldOf, issueOf, rootOf } from './workspace-mission-reads'

const stamp = '2026-10-09T00:00:00Z'
const issue = (id: string, parentId: string | null = null) => ({
  id, parentId, seq: 1, title: id, stage: 'in_progress', audience: 'human',
  deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp,
})

function fixture() {
  const rows = new Map([['root', issue('root')], ['child', issue('child', 'root')]])
  const exits = new Map<string, 'removed'>([['removed', 'removed']])
  const load = vi.fn((_entity: string, id: string) => rows.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    load, schedule: () => () => {}, exitKind: (_entity, id) => exits.get(id),
  })
  pool.apply({ type: 'replace', rows: [...rows].map(([id, value]) => ({ kind: 'issue' as const, id, value })) })
  return { pool, rows, exits, load }
}

it('keeps pending workspace selections loading and omits removed or inaccessible selections', () => {
  const f = fixture()
  try {
    expect(rootOf(f.pool, 'root')).toBe('root')
    expect(rootOf(f.pool, 'removed')).toBeUndefined()
    expect(rootOf(f.pool, 'private')).toBe(LOADING)
    f.pool.hydrate()
    expect(rootOf(f.pool, 'private')).toBeUndefined()
    expect(f.pool.hydrate()).toBe(0)
    expect(f.load).toHaveBeenCalledTimes(1)
  } finally { f.pool.dispose() }
})

it('falls back to the mission root when its focused member is removed before publication', () => {
  const f = fixture()
  try {
    expect(issueOf(f.pool, 'root', 'child')).toBe('child')
    f.exits.set('child', 'removed')
    expect(issueOf(f.pool, 'root', 'child')).toBe('root')
    expect(f.pool.hydrate()).toBe(0)
    expect(f.load).not.toHaveBeenCalled()
  } finally { f.pool.dispose() }
})

it('reads optional resident workspace details and omits both pending and gone records', () => {
  const f = fixture()
  try {
    expect(fieldOf(f.pool, 'root', 'repoPath')).toBe('/synthetic')
    expect(fieldOf(f.pool, 'removed', 'repoPath')).toBeNull()
    expect(fieldOf(f.pool, 'private', 'repoPath')).toBeNull()
    f.pool.hydrate()
    expect(fieldOf(f.pool, 'private', 'repoPath')).toBeNull()
    expect(f.pool.hydrate()).toBe(0)
    expect(f.load).toHaveBeenCalledTimes(1)
  } finally { f.pool.dispose() }
})
