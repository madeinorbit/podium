import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { EMPTY_PENDING } from '../../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from '../create'
import { fixedLocals } from '../shared/locals-source'
import { createRowSource } from '../shared/row-source'
import { sidebarView } from './sidebar'

// POD-6246, through the production feed: replica rows, discovery and the row
// source, as the app receives them. The podium repo is checked out on two
// machines; the server's repo row carries the alphabetically first checkout as
// its path (the Mac's `bak_podium` copy) and the repo's name, "podium"
// (`repoProjectionRows`). The sidebar shows that name through a full load, a
// base-branch edit (a repo record alone), a prefix edit, a rescope replace and
// a new scan, and follows the server when the name changes.
const now = Date.parse('2026-11-02T12:00:00Z')
const stamp = new Date(now - 60_000).toISOString()
const repoId = 'repo-podium'
const home = '/home/mgw/src/other/podium'
const backup = '/Users/mw/Source/other/bak_podium'
type Row = Readonly<Record<string, unknown>>

function fixture() {
  const tables = new Map<ReplicaKind, Map<string, Row>>()
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const put = (kind: ReplicaKind, id: string, row: Row) => {
    const table = tables.get(kind) ?? new Map<string, Row>()
    tables.set(kind, table)
    table.set(id, row)
  }
  put('repos', repoId, {
    id: repoId,
    prefix: 'POD',
    defaultParentBranch: null,
    repoPath: backup,
    name: 'podium',
  })
  for (const [id, seq] of [
    ['home-issue', 1],
    ['backup-issue', 2],
  ] as const)
    put('issueProjections', id, {
      id,
      repoId,
      seq,
      title: id,
      stage: 'in_progress',
      audience: 'human',
      createdAt: stamp,
      updatedAt: stamp,
    })
  let discovery = [
    {
      path: home,
      repoId,
      machineId: 'ludovico',
      originUrl: 'https://github.com/madeinorbit/podium.git',
      worktrees: [],
    },
    {
      path: backup,
      repoId,
      machineId: 'mac',
      originUrl: 'git@github.com:madeinorbit/podium.git',
      worktrees: [],
    },
  ]
  let localChanged = () => {}
  const source = createRowSource(
    {
      principal: { userId: 'operator' },
      readLocal: () => discovery,
      onLocals: (_keys, listener) => {
        localChanged = listener
        return () => {}
      },
    },
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
  return {
    pool: handle.pool,
    changeRepo(patch: Row) {
      put('repos', repoId, { ...tables.get('repos')?.get(repoId), ...patch })
      addressed({ type: 'update', rows: [{ kind: 'repos', id: repoId }] })
      return source.flush()
    },
    rescope() {
      addressed({ type: 'replace', reason: 'rescope' })
      return source.flush()
    },
    /** A replica change no update announces: only a replace carries it. */
    changeRepoSilently(patch: Row) {
      put('repos', repoId, { ...tables.get('repos')?.get(repoId), ...patch })
    },
    addCheckout(path: string, machineId: string) {
      discovery = [
        ...discovery,
        {
          path,
          repoId,
          machineId,
          originUrl: 'git@github.com:madeinorbit/podium.git',
          worktrees: [],
        },
      ]
      localChanged()
      return source.flush()
    },
    dispose() {
      handle.dispose()
      source.dispose()
    },
  }
}

it('names the podium group "podium" through load, base-branch and prefix edits, a replace and a new scan', () => {
  const f = fixture()
  const labels: (string | undefined)[] = []
  const stop = autorun(() => {
    const band = sidebarView(f.pool)
      .sections()
      .bands.find((b) => b.key === repoId)
    labels.push(band?.label)
  })
  try {
    expect(labels).toEqual(['podium'])
    // The user's step: a base branch set on the repo publishes the repo record alone.
    expect(f.changeRepo({ defaultParentBranch: 'dev/mw' })?.rows.map((r) => r.kind)).toEqual([
      'repo',
    ])
    f.changeRepo({ prefix: 'PDM' })
    f.rescope()
    f.addCheckout('/Users/mw/Source/podium/podium', 'mac')
    f.changeRepo({ defaultParentBranch: null })
    expect(new Set(labels)).toEqual(new Set(['podium']))
    const band = sidebarView(f.pool)
      .sections()
      .bands.find((b) => b.key === repoId)
    expect(band?.rowIds).toEqual(expect.arrayContaining(['home-issue', 'backup-issue']))
  } finally {
    stop()
    f.dispose()
  }
})

it('follows the server when it renames the repo, by update and inside a replace', () => {
  const f = fixture()
  const labels: (string | undefined)[] = []
  const stop = autorun(() => {
    labels.push(
      sidebarView(f.pool)
        .sections()
        .bands.find((b) => b.key === repoId)?.label,
    )
  })
  try {
    f.changeRepo({ name: 'podium-app' })
    // A replace reads this slice's record, not the one held before it.
    f.changeRepoSilently({ name: 'podium-next' })
    f.rescope()
    expect(labels).toEqual(['podium', 'podium-app', 'podium-next'])
  } finally {
    stop()
    f.dispose()
  }
})
