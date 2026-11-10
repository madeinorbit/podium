import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { repositoryCheckouts } from '@podium/client-core/test-support/machine-records'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { EMPTY_PENDING } from '../../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from '../create'
import { myPreferences } from '../per-user-records'
import { fixedLocals } from '../shared/locals-source'
import { createRowSource } from '../shared/row-source'
import { sidebarView } from './sidebar'

type Row = Readonly<Record<string, unknown>>
const now = Date.parse('2026-11-10T12:00:00Z')

it('honours synced Custom, A–Z and Recent project orders through the real feed', () => {
  const tables = new Map<ReplicaKind, Map<string, Row>>()
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const put = (kind: ReplicaKind, id: string, row: Row) => {
    const table = tables.get(kind) ?? new Map<string, Row>()
    tables.set(kind, table)
    table.set(id, row)
  }
  for (const [name, age] of [
    ['alpha', 3],
    ['beta', 1],
    ['gamma', 2],
    ['delta', 0],
  ] as const) {
    const path = `/code/${name}`
    put('repos', name, { id: name, name, prefix: name.toUpperCase(), repoPath: path })
    for (const record of repositoryCheckouts(
      {
        path,
        repoId: name,
        kind: 'repository',
        originUrl: `https://example.com/${name}.git`,
        worktrees: [],
      } as never,
      'test-machine',
    ))
      put('checkouts', record.entityId, record.value)
    // Include an empty registered project; it remains available in every mode.
    if (name === 'delta') continue
    const stamp = new Date(now - age * 60_000).toISOString()
    put('issueProjections', `${name}-task`, {
      id: `${name}-task`,
      repoId: name,
      seq: 1,
      title: name,
      stage: 'in_progress',
      audience: 'human',
      createdAt: stamp,
      updatedAt: stamp,
    })
  }
  put('userPreferences', 'operator', {
    'sidebar.repoSort': 'custom',
    'sidebar.repoOrder': ['gamma', 'beta', 'alpha', 'delta'],
  })
  const source = createRowSource(
    { principal: { userId: 'operator' } },
    {
      row: (kind, id) => tables.get(kind)?.get(id),
      rows: (kind) => [...(tables.get(kind)?.values() ?? [])],
      subscribeAddressedBatch(listener) {
        addressed = listener
        return () => {}
      },
    },
    { pending: EMPTY_PENDING },
  )
  const handle = createWorklistPool(
    source.source,
    fixedLocals({ selectedIssueId: null, coarseNow: now }).source,
  )
  const orders: string[][] = []
  const stop = autorun(() => {
    const sidebar = myPreferences(handle.pool)?.sidebar
    orders.push(
      sidebarView(handle.pool)
        .sections({ projectSort: sidebar?.repoSort, projectOrder: sidebar?.repoOrder })
        .bands.map((band) => band.key),
    )
  })
  const update = (kind: ReplicaKind, id: string, patch: Row) => {
    put(kind, id, { ...tables.get(kind)?.get(id), ...patch })
    addressed({ type: 'update', rows: [{ kind, id }] })
    source.flush()
  }
  try {
    expect(orders.at(-1)).toEqual(['gamma', 'beta', 'alpha', 'delta'])
    update('userPreferences', 'operator', { 'sidebar.repoSort': 'alphabetical' })
    expect(orders.at(-1)).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    update('userPreferences', 'operator', { 'sidebar.repoSort': 'lastUsed' })
    expect(orders.at(-1)).toEqual(['beta', 'gamma', 'alpha', 'delta'])
    update('issueProjections', 'alpha-task', { updatedAt: new Date(now).toISOString() })
    expect(orders.at(-1)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    update('userPreferences', 'operator', { 'sidebar.repoSort': 'custom' })
    expect(orders.at(-1)).toEqual(['gamma', 'beta', 'alpha', 'delta'])
  } finally {
    stop()
    handle.dispose()
    source.dispose()
  }
})
