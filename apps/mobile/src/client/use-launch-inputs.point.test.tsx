import { headerEntities } from '@podium/client-graph/header-entities'
import { headerView } from '@podium/client-graph/header-views'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import { launchRepositoryFacts } from '../../../../packages/client-graph/src/test-support/launch-repository-facts.test.fixture'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { useLaunchInputs } from './use-launch-inputs'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('./mobile-pool', () => ({
  useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const projection = useMemo(() => createPoolProjection(state.pool!, read), [read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Product consumers are observers: the hook supplies a model, whose fields
// are read by the consumer rather than copied into the hook's projection.
function renderLaunchInputs(path: string) {
  let current!: {
    repo: ReturnType<typeof launchRepositoryFacts>
    machines: ReturnType<typeof useLaunchInputs>['machines']
  }
  const Consumer = observer(({ path }: { path: string }) => {
    const inputs = useLaunchInputs(path)
    current = { repo: launchRepositoryFacts(inputs.repo), machines: inputs.machines }
    return null
  })
  const view = render(<Consumer path={path} />)
  return {
    result: { get current() { return current } },
    rerender: ({ path }: { path: string }) => view.rerender(<Consumer path={path} />),
    unmount: () => view.unmount(),
  }
}

it('keeps Ludovico available when a task names its non-primary clone or linked checkout', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  state.pool = pool
  const primary: GitRepositoryWire = {
    kind: 'repository', path: '/Users/mw/nulldisk', worktrees: [],
    repoId: 'nulldisk' as GitRepositoryWire['repoId'], machineId: 'mac' as MachineWire['id'],
  }
  const clone: GitRepositoryWire = {
    ...primary, path: '/home/mgw/nulldisk', machineId: 'ludovico' as MachineWire['id'],
    worktrees: [{ path: '/home/mgw/nulldisk/topic' }],
  }
  headerEntities(pool).apply([
    { kind: 'repository', id: 'primary', value: primary },
    { kind: 'repository', id: 'clone', value: clone },
    { kind: 'machine', id: 'ludovico', value: { id: 'ludovico', name: 'Ludovico', online: true } as MachineWire },
  ])
  headerEntities(pool).order('machine', ['ludovico'])
  const view = renderLaunchInputs(clone.path)
  try {
    expect(view.result.current.repo?.machines.map(host => host.machineId)).toContain('ludovico')
    view.rerender({ path: clone.worktrees[0]!.path })
    expect(view.result.current.repo?.machines.map(host => host.machineId)).toContain('ludovico')
    act(() => headerEntities(pool).apply([{ kind: 'repository', id: 'clone', value: undefined }]))
    expect(view.result.current.repo).toBeUndefined()
  } finally {
    view.unmount()
    pool.dispose()
  }
})

it('the actual launch hook reads its named repository and ignores unrelated catalog changes at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    state.pool = pool
    const repos: GitRepositoryWire[] = Array.from({ length: 128 * scale }, (_, at) => ({
      kind: 'repository',
      path: `/repo/${at}`,
      originUrl: `https://example.test/project-${at}`,
      worktrees: [],
    }))
    headerEntities(pool).apply([
      ...repos.map((value, at) => ({ kind: 'repository' as const, id: `r${at}`, value })),
      {
        kind: 'machine',
        id: 'm0',
        value: { id: 'm0', name: 'Only host', online: true } as MachineWire,
      },
    ])
    headerEntities(pool).order('machine', ['m0'])
    const ids = vi.spyOn(headerView(pool), 'ids')
    const keys = vi.spyOn(headerEntities(pool).tables.repository, 'keys')
    let view:
      | ReturnType<typeof renderLaunchInputs>
      | undefined
    const measure = (action: () => void) =>
      measureWork(
        async () => {
          act(action)
          await act(async () => {})
        },
        { pool },
      )
    try {
      const first = await measure(() => {
        view = renderLaunchInputs('/repo/0')
      })
      expect(view!.result.current.repo?.path).toBe('/repo/0')
      expect(view!.result.current.machines).toHaveLength(1)
      const unrelated = await measure(() =>
        headerEntities(pool).apply([
          { kind: 'repository', id: 'r17', value: { ...repos[17]!, branch: 'changed' } },
        ]),
      )
      expect(unrelated.work.rows).toBe(0)
      const changed = await measure(() =>
        headerEntities(pool).apply([
          { kind: 'repository', id: 'r0', value: { ...repos[0]!, branch: 'selected' } },
        ]),
      )
      expect(view!.result.current.repo?.worktrees[0]?.branch).toBe('selected')
      const select = await measure(() => view!.rerender({ path: '/repo/23' }))
      expect(view!.result.current.repo?.path).toBe('/repo/23')
      const absent = await measure(() => view!.rerender({ path: '/absent' }))
      expect(view!.result.current.repo).toBeUndefined()
      view!.unmount()
      const closed = await measure(() =>
        headerEntities(pool).apply([
          { kind: 'repository', id: 'r23', value: { ...repos[23]!, branch: 'closed' } },
        ]),
      )
      expect(closed.work.rows).toBe(0)
      expect(ids).not.toHaveBeenCalled()
      expect(keys).not.toHaveBeenCalled()
      samples.push({
        scale,
        first: first.work,
        unrelated: unrelated.work,
        changed: changed.work,
        select: select.work,
        absent: absent.work,
        closed: closed.work,
      })
    } finally {
      view?.unmount()
      pool.dispose()
      cleanup()
    }
  }
  console.info('[actual launch hook repository work1x4x]', JSON.stringify(samples))
  for (const action of ['first', 'unrelated', 'changed', 'select', 'absent', 'closed'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]![action][counter], `${action}:${counter}`).toBe(
        samples[0]![action][counter],
      )
})
