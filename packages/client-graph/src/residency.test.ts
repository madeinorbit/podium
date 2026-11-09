import { expect, it, vi } from 'vitest'
import { insideArm, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { LOADING } from './loading'
import { omitGone } from './lookup'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'

const old = '2020-01-01T00:00:00Z'
const now = '2026-11-09T12:00:00Z'
const later = '2026-11-09T12:01:00Z'

function issue(id: string, patch: object = {}): RowRecord {
  return {
    kind: 'issue',
    id,
    value: {
      id,
      title: id,
      seq: 1,
      stage: 'in_progress',
      audience: 'human',
      archived: false,
      createdAt: old,
      updatedAt: old,
      repoPath: '/project',
      ...patch,
    },
  } as RowRecord
}

function fixture(history: number, external: boolean, patch: object = {}) {
  const source = new Map<string, object>()
  const index = external ? createColdIndex(SCHEMA) : undefined
  const load = vi.fn((kind: string, id: string) => source.get(`${kind}:${id}`))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(now) }, undefined, {
    ...(index ? { cold: () => index } : {}),
    load,
    schedule: () => () => {},
  })
  const apply = (event: RowSourceEvent) => {
    for (const row of event.rows) {
      if (row.value === undefined) source.delete(`${row.kind}:${row.id}`)
      else source.set(`${row.kind}:${row.id}`, row.value)
    }
    index?.apply(event)
    pool.apply(event)
  }
  const owner = issue('owner', { parentId: 'parent', ...patch })
  apply({
    type: 'replace',
    rows: [
      issue('parent'),
      owner,
      ...Array.from(
        { length: history },
        (_, n) =>
          ({
            kind: 'session',
            id: `history-${n}`,
            value: {
              sessionId: `history-${n}`,
              issueId: 'owner',
              archived: true,
              status: 'exited',
              agentKind: 'codex',
              cwd: '/project',
              createdAt: old,
              lastActiveAt: old,
              stoppedAt: old,
            },
          }) as RowRecord,
      ),
    ],
  })
  return { pool, apply, load, owner }
}

async function acknowledgementWork(history: number, external: boolean) {
  const f = fixture(history, external)
  const acknowledged = { ...(f.owner.value as object), readAt: now }
  const renamed = { ...acknowledged, title: 'Renamed' }
  try {
    const counted = await measureWork(
      async () => {
        insideArm(() => {
          f.apply({ type: 'update', rows: [{ ...f.owner, value: acknowledged }] })
          f.apply({ type: 'update', rows: [{ ...f.owner, value: renamed }] })
          f.apply({ type: 'update', rows: [{ ...f.owner, value: { ...renamed, readAt: later } }] })
        })
      },
      { pool: f.pool },
    )
    expect(f.pool.readCursor('owner')).toBe(later)
    expect(omitGone(f.pool.row('issue', 'owner'))).toMatchObject({ title: 'Renamed' })
    expect(f.load).not.toHaveBeenCalled()
    return counted.work
  } finally {
    f.pool.dispose()
  }
}

it.each([
  false,
  true,
])('keeps cursor and display publications independent of archived history (external source: %s)', async (external) => {
  const one = await acknowledgementWork(32, external)
  const four = await acknowledgementWork(128, external)
  expect(four.elements).toBeLessThanOrEqual(one.elements)
  expect(four.visits).toBeLessThanOrEqual(one.visits)
  expect(four.rows).toBe(one.rows)
})

it.each([
  false,
  true,
])('warms inherited rows when a cold owner reopens (external source: %s)', (external) => {
  const f = fixture(2, external, { archived: true, stage: 'done', closedAt: old })
  try {
    expect(f.pool.tables.issue.has('owner')).toBe(false)
    expect(f.pool.tables.session.size).toBe(0)
    f.apply({ type: 'update', rows: [issue('owner', { parentId: 'parent' })] })
    expect(f.pool.tables.issue.has('owner')).toBe(true)
    expect(f.load).not.toHaveBeenCalled()
    expect(f.pool.hydrate()).toBe(2)
    expect(f.pool.tables.session.size).toBe(2)
    expect(f.load.mock.calls).toEqual([
      ['session', 'history-0'],
      ['session', 'history-1'],
    ])
  } finally {
    f.pool.dispose()
  }
})

it.each([
  false,
  true,
])('preserves warming when a late read extends a completed owner bound (external source: %s)', (external) => {
  const f = fixture(1, external, { stage: 'done', closedAt: old })
  try {
    expect(f.pool.tables.issue.has('owner')).toBe(false)
    expect(f.pool.tables.session.size).toBe(0)
    f.apply({
      type: 'update',
      rows: [{ ...f.owner, value: { ...(f.owner.value as object), readAt: now } }],
    })
    expect(omitGone(f.pool.row('issue', 'owner'))).not.toBe(LOADING)
    expect(f.pool.tables.issue.has('owner')).toBe(true)
    expect(f.pool.hydrate()).toBe(1)
    expect(f.pool.tables.session.has('history-0')).toBe(true)
  } finally {
    f.pool.dispose()
  }
})
