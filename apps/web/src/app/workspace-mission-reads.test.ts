import { LOADING, MobxPool } from '@podium/client-graph'
import type { CollectionLoaderPort } from '@podium/client-graph/shared/source'
import { expect, it, vi } from 'vitest'
import { fieldOf, issueOf, rootOf } from './workspace-mission-reads'

const stamp = '2026-10-09T00:00:00Z'
const issue = (id: string, parentId: string | null = null) => ({
  id,
  parentId,
  seq: 1,
  title: id,
  stage: 'in_progress',
  audience: 'human',
  deps: [],
  repoPath: '/synthetic',
  createdAt: stamp,
  updatedAt: stamp,
})

function fixture(coldChild = false) {
  const child = {
    ...issue('child', 'root'),
    ...(coldChild
      ? {
          stage: 'done',
          closedAt: '2020-01-01T00:00:00Z',
          updatedAt: '2020-01-01T00:00:00Z',
        }
      : {}),
  }
  const rows = new Map([
    ['root', issue('root')],
    ['child', child],
  ])
  const exits = new Map<string, 'removed'>([['removed', 'removed']])
  const answered = new Set<string>()
  const requests = vi.fn()
  const loader: CollectionLoaderPort = {
    request: requests,
    show: () => () => {},
    status: () => 'loading',
    online: true,
    firstDownload: false,
    isComplete: (spec) =>
      spec.collection.endsWith('.one')
        ? answered.has(String(spec.args?.id))
          ? {}
          : undefined
        : {},
    wasRefused: () => false,
    stubOf: () => undefined,
    stubsByParent: () => [],
    stubRows: () => [],
    subscribe: () => () => {},
  }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    loader: () => loader,
    schedule: () => () => {},
    exitKind: (_entity, id) => exits.get(id),
  })
  pool.apply({
    type: 'replace',
    rows: [...rows].map(([id, value]) => ({ kind: 'issue' as const, id, value })),
  })
  return { pool, rows, exits, requests, answerAbsent: (id: string) => answered.add(id) }
}

it('keeps pending workspace selections loading and omits removed or inaccessible selections', () => {
  const f = fixture()
  try {
    expect(rootOf(f.pool, 'root')).toBe('root')
    expect(rootOf(f.pool, 'removed')).toBeUndefined()
    expect(rootOf(f.pool, 'private')).toBe(LOADING)
    f.answerAbsent('private')
    expect(rootOf(f.pool, 'private')).toBeUndefined()
    expect(f.pool.hydrate()).toBe(0)
    expect(f.requests).toHaveBeenCalled()
    const count = f.requests.mock.calls.length
    rootOf(f.pool, 'private')
    expect(f.requests).toHaveBeenCalledTimes(count)
  } finally {
    f.pool.dispose()
  }
})

it('falls back to the mission root when a resident focused member is removed before publication', () => {
  const f = fixture(true)
  try {
    expect(issueOf(f.pool, 'root', 'child')).toBe('child')
    f.exits.set('child', 'removed')
    expect(issueOf(f.pool, 'root', 'child')).toBe('root')
    expect(f.pool.hydrate()).toBe(0)
    expect(f.pool.tables.issue.has('child')).toBe(true)
    expect(fieldOf(f.pool, 'child', 'repoPath')).toBeNull()
    expect(f.requests).not.toHaveBeenCalled()
  } finally {
    f.pool.dispose()
  }
})

it('reads optional resident workspace details and omits both pending and gone records', () => {
  const f = fixture()
  try {
    expect(fieldOf(f.pool, 'root', 'repoPath')).toBe('/synthetic')
    expect(fieldOf(f.pool, 'removed', 'repoPath')).toBeNull()
    expect(fieldOf(f.pool, 'private', 'repoPath')).toBeNull()
    f.answerAbsent('private')
    expect(fieldOf(f.pool, 'private', 'repoPath')).toBeNull()
    expect(f.pool.hydrate()).toBe(0)
    expect(f.requests).toHaveBeenCalled()
    const count = f.requests.mock.calls.length
    fieldOf(f.pool, 'private', 'repoPath')
    expect(f.requests).toHaveBeenCalledTimes(count)
  } finally {
    f.pool.dispose()
  }
})
