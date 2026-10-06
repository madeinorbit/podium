import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { cwdInWorktree, reposToViews } from '@podium/client-core/values'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'

const scan = (path: string, repoId: string, machineId?: string): HeaderRows['repository'] => ({
  kind: 'repository',
  path,
  repoId: repoId as HeaderRows['repository']['repoId'],
  machineId: machineId as HeaderRows['repository']['machineId'],
  worktrees: [],
})

it('bounds first shipping demand and single-repository updates even when unrelated machines share the path', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const target = scan('/shared', 'target', 'm0'),
      clone = scan('/clone', 'target', 'm1')
    const wildcard = scan('/shared', 'wildcard')
    const otherMachines = Array.from({ length: 128 * scale }, (_, at) =>
      scan('/shared', `other-${at}`, `unused-${at}`),
    )
    const otherPaths = Array.from({ length: 128 * scale }, (_, at) =>
      scan(`/elsewhere/${at}`, `path-${at}`, `elsewhere-${at}`),
    )
    const window = {
      view: 'workspace',
      paneA: 'file',
      fileTabs: [
        { id: 'file', worktreePath: '/shared/sub', scope: { kind: 'worktree', machineId: 'm0' } },
      ],
      outboxSize: 0,
    } as HeaderRows['window']
    headerEntities(pool).apply([
      { kind: 'window', id: 'window', value: window },
      { kind: 'repository', id: 'target', value: target },
      { kind: 'repository', id: 'clone', value: clone },
      { kind: 'repository', id: 'wildcard', value: wildcard },
      ...otherMachines.map((value, at) => ({
        kind: 'repository' as const,
        id: `machine-${at}`,
        value,
      })),
      ...otherPaths.map((value, at) => ({ kind: 'repository' as const, id: `path-${at}`, value })),
      {
        kind: 'shipOrder',
        id: 'target-order',
        value: {
          id: 'target-order',
          repoId: 'target',
          humanState: 'needs_you',
        } as HeaderRows['shipOrder'],
      },
      {
        kind: 'shipOrder',
        id: 'wildcard-order',
        value: {
          id: 'wildcard-order',
          repoId: 'wildcard',
          humanState: 'waiting',
        } as HeaderRows['shipOrder'],
      },
    ])
    let value = { unfinishedCount: 0, decisionCount: 0 },
      stop = () => {},
      paints = 0
    const ids = vi.spyOn(headerView(pool), 'ids')
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
    try {
      const first = await measure('first shipping pane demand', () => {
        stop = autorun(() => {
          value = headerView(pool).shipping()
          paints++
        })
      })
      expect(value).toEqual({ unfinishedCount: 1, decisionCount: 1 })
      const point = await measure('addressed shipping scope', () => {
        expect(headerEntities(pool).shippingScope('/shared/sub', 'unused-17')?.repoId).toBe('wildcard')
        expect(headerEntities(pool).shippingScope('/shared/sub')?.repoId).toBe('target')
        expect(headerEntities(pool).shippingScope('/absent', 'm0')).toBeUndefined()
      })
      expect(point.work.rows).toBe(0)
      const before = paints
      const metadata = await measure('other shared-path repository branch', () =>
        headerEntities(pool).apply([
          {
            kind: 'repository',
            id: 'machine-17',
            value: { ...otherMachines[17]!, branch: 'changed' },
          },
        ]),
      )
      expect(paints).toBe(before)
      const machine = await measure('other shared-path machine changes', () =>
        headerEntities(pool).apply([
          {
            kind: 'repository',
            id: 'machine-17',
            value: {
              ...otherMachines[17]!,
              machineId: 'unused-new' as HeaderRows['repository']['machineId'],
            },
          },
        ]),
      )
      expect(paints).toBe(before)
      const rekey = await measure('other shared-path repository identity changes', () =>
        headerEntities(pool).apply([
          {
            kind: 'repository',
            id: 'machine-18',
            value: {
              ...otherMachines[18]!,
              repoId: 'other-moved' as HeaderRows['repository']['repoId'],
            },
          },
        ]),
      )
      expect(paints).toBe(before)
      const selected = await measure('selected machine stops owning the lane', () =>
        headerEntities(pool).apply([
          {
            kind: 'repository',
            id: 'target',
            value: { ...target, machineId: 'm9' as HeaderRows['repository']['machineId'] },
          },
        ]),
      )
      expect(value).toEqual({ unfinishedCount: 1, decisionCount: 0 })
      const restored = await measure('selected machine owns the lane again', () =>
        headerEntities(pool).apply([{ kind: 'repository', id: 'target', value: target }]),
      )
      expect(value).toEqual({ unfinishedCount: 1, decisionCount: 1 })
      const removed = await measure('one other shared-path repository removed', () =>
        headerEntities(pool).apply([{ kind: 'repository', id: 'machine-19', value: undefined }]),
      )
      expect(value).toEqual({ unfinishedCount: 1, decisionCount: 1 })
      expect(ids).not.toHaveBeenCalled()
      stop()
      const closed = await measure('shipping consumer closed', () =>
        headerEntities(pool).apply([
          {
            kind: 'repository',
            id: 'target',
            value: { ...target, machineId: 'm9' as HeaderRows['repository']['machineId'] },
          },
        ]),
      )
      expect(closed.work.rows).toBe(0)
      const control = await measure('planted whole-repository shipping scope', () => {
        const scans = headerView(pool).ids('repository').flatMap((id) => {
          const row = headerView(pool).row('repository', id)
          return row ? [row] : []
        })
        const result = reposToViews(scans).find((repo) =>
          repo.worktrees.some(
            (lane) =>
              (!lane.machineId || lane.machineId === 'm0') &&
              cwdInWorktree('/shared/sub', lane.path),
          ),
        )
        expect(result?.repoId).toBe('wildcard')
      })
      samples.push({
        scale,
        actions: { first, point, metadata, machine, rekey, selected, restored, removed, closed },
        control,
      })
    } finally {
      stop()
      ids.mockRestore()
      pool.dispose()
    }
  }
  console.info('[shipping addressed scope work1x4x]', JSON.stringify(samples))
  for (const action of [
    'first',
    'point',
    'metadata',
    'machine',
    'rekey',
    'selected',
    'restored',
    'removed',
    'closed',
  ] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]!.actions[action].work[counter], `${action}:${counter}`).toBe(
        samples[0]!.actions[action].work[counter],
      )
  expect(samples[1]!.control.work.rows).toBeGreaterThan(samples[0]!.control.work.rows ?? 0)
  expect(samples[1]!.control.work.elements).toBeGreaterThan(samples[0]!.control.work.elements)
})
