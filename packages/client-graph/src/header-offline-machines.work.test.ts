import { omitGone } from './lookup'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { isMachineOfflineForLiveTerminal } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import type { HeaderRecord, HeaderRows } from './header-schema'
import { MobxPool } from './pool'

const WEEK = 7 * 86_400_000
const NOW = Date.parse('2026-10-05T12:00:00Z')
function machine(id: string, online: boolean, seen: number): HeaderRows['machine'] {
  return {
    id: id as HeaderRows['machine']['id'],
    name: id,
    hostname: id,
    online,
    lastSeenAt: new Date(seen).toISOString(),
  }
}
function metric(id: string): HeaderRows['hostMetric'] {
  return {
    machineId: id as HeaderRows['hostMetric']['machineId'],
    hostname: id,
    sampledAt: new Date(NOW).toISOString(),
  } as HeaderRows['hostMetric']
}

it('bounds the actual offline header window across online fleet and expired history at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    const target = machine('target', false, NOW - WEEK + 1000)
    const online = Array.from({ length: 128 * scale }, (_, at) =>
      machine(`online-${at}`, true, NOW),
    )
    const expired = Array.from({ length: 128 * scale }, (_, at) =>
      machine(`expired-${at}`, false, NOW - 2 * WEEK),
    )
    headerEntities(pool).apply([
      ...online.map((value) => ({ kind: 'machine' as const, id: value.id, value })),
      ...expired.map((value) => ({ kind: 'machine' as const, id: value.id, value })),
      ...online.map((value) => ({
        kind: 'hostMetric' as const,
        id: value.id,
        value: metric(value.id),
      })),
      { kind: 'machine', id: 'target', value: target },
    ])
    let answer: HeaderRows['machine'][] = [],
      paints = 0,
      stop = () => {}
    const ids = vi.spyOn(headerView(pool), 'ids')
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
    const apply = (records: HeaderRecord[]) => headerEntities(pool).apply(records)
    try {
      const first = await measure('first offline header window', () => {
        stop = autorun(() => {
          answer = headerView(pool).offlineMachines()
          paints++
        })
      })
      expect(answer).toEqual([target])
      expect(first.work.rows).toBe(1)
      const before = paints
      const onlineMetadata = await measure('online machine metadata', () =>
        apply([
          {
            kind: 'machine',
            id: online[17]!.id,
            value: { ...online[17]!, name: 'Renamed online' },
          },
        ]),
      )
      const expiredMetadata = await measure('expired machine metadata', () =>
        apply([
          {
            kind: 'machine',
            id: expired[17]!.id,
            value: { ...expired[17]!, name: 'Renamed history' },
          },
        ]),
      )
      const sample = await measure('unrelated metric sample', () =>
        apply([
          {
            kind: 'hostMetric',
            id: online[18]!.id,
            value: { ...metric(online[18]!.id), hostname: 'Updated sample' },
          },
        ]),
      )
      expect(paints).toBe(before)
      for (const action of [onlineMetadata, expiredMetadata, sample])
        expect(action.work.rows).toBe(0)
      const renamed = { ...target, name: 'Renamed target' }
      const selected = await measure('visible offline metadata', () =>
        apply([{ kind: 'machine', id: 'target', value: renamed }]),
      )
      expect(answer).toEqual([renamed])
      expect(selected.work.rows).toBe(1)
      const quiet = await measure('quiet clock tick', () => pool.clock.advance(NOW + 500))
      const exact = await measure('exact offline window boundary', () =>
        pool.clock.advance(NOW + 1000),
      )
      expect(answer).toEqual([renamed])
      expect(quiet.work.rows).toBe(0)
      expect(exact.work.rows).toBe(0)
      const expiry = await measure('one offline machine expires', () =>
        pool.clock.advance(NOW + 1001),
      )
      expect(answer).toEqual([])
      const expiredUpdate = await measure('expired selected machine changes', () =>
        apply([{ kind: 'machine', id: 'target', value: { ...renamed, name: 'Hidden target' } }]),
      )
      expect(expiredUpdate.work.rows).toBe(0)
      const rewind = await measure('clock rewind restores window member', () =>
        pool.clock.advance(NOW),
      )
      expect(answer.map((value) => value.name)).toEqual(['Hidden target'])
      expect(rewind.work.rows).toBe(1)
      const sampled = await measure('offline machine gains metric', () =>
        apply([{ kind: 'hostMetric', id: 'sample-a', value: metric('target') }]),
      )
      expect(answer).toEqual([])
      const second = await measure('second metric for same machine', () =>
        apply([{ kind: 'hostMetric', id: 'sample-b', value: metric('target') }]),
      )
      const retainSample = await measure('one of two samples removed', () =>
        apply([{ kind: 'hostMetric', id: 'sample-a', value: undefined }]),
      )
      expect(answer).toEqual([])
      const unsampled = await measure('last metric removed', () =>
        apply([{ kind: 'hostMetric', id: 'sample-b', value: undefined }]),
      )
      expect(answer.map((value) => value.id)).toEqual(['target'])
      const becameOnline = await measure('selected machine becomes online', () =>
        apply([{ kind: 'machine', id: 'target', value: { ...target, online: true } }]),
      )
      expect(answer).toEqual([])
      const becameOffline = await measure('selected machine loses daemon', () =>
        apply([
          {
            kind: 'machine',
            id: 'target',
            value: {
              ...target,
              online: true,
              availability: { epoch: 'current', server: true, supervisor: true, daemon: false },
            },
          },
        ]),
      )
      expect(answer.map((value) => value.id)).toEqual(['target'])
      const removed = await measure('offline machine removed', () =>
        apply([{ kind: 'machine', id: 'target', value: undefined }]),
      )
      expect(answer).toEqual([])
      expect(ids).not.toHaveBeenCalled()
      stop()
      const closedPaints = paints
      const closed = await measure('offline header unmounted', () => {
        apply([{ kind: 'machine', id: 'target', value: target }])
        pool.clock.advance(NOW + 2000)
      })
      expect(paints).toBe(closedPaints)
      expect(closed.work.rows).toBe(0)
      const control = await measure('former whole-fleet offline lookup', () => {
        const sampledIds = new Set(
          headerView(pool)
            .ids('hostMetric')
            .map((id) => headerEntities(pool).one('hostMetric', id, 'machine')),
        )
        headerView(pool).ids('machine').flatMap((id) => {
          const value = omitGone(pool.row('machine', id)) as HeaderRows['machine'] | undefined
          if (
            !value ||
            !isMachineOfflineForLiveTerminal(value) ||
            sampledIds.has(id) ||
            value.serviceAssignment?.agentExecution === false ||
            value.revokedAt ||
            value.supersededBy
          )
            return []
          const seen = Date.parse(value.lastSeenAt)
          return Number.isFinite(seen) && !pool.clock.passed(seen + WEEK) ? [value] : []
        })
      })
      expect(control.work.rows).toBe(256 * scale + 1)
      samples.push({
        scale,
        actions: {
          first,
          onlineMetadata,
          expiredMetadata,
          sample,
          selected,
          quiet,
          exact,
          expiry,
          expiredUpdate,
          rewind,
          sampled,
          second,
          retainSample,
          unsampled,
          becameOnline,
          becameOffline,
          removed,
          closed,
        },
        control,
      })
    } finally {
      stop()
      ids.mockRestore()
      pool.dispose()
    }
  }
  console.info('[offline header work1x4x]', JSON.stringify(samples))
  for (const name of Object.keys(samples[0]!.actions) as (keyof (typeof samples)[0]['actions'])[])
    for (const counter of ['rows', 'derivations', 'elements'] as const)
      expect(samples[1]!.actions[name].work[counter], `${name}:${counter}`).toBe(
        samples[0]!.actions[name].work[counter],
      )
  expect(samples[1]!.control.work.elements).toBeGreaterThan(samples[0]!.control.work.elements)
})

it('preserves all eligibility rules, source order, metric reassignment and replacement', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  const base = machine('a', false, NOW),
    b = machine('b', false, NOW)
  const excluded = [
    { ...machine('online', true, NOW) },
    {
      ...machine('disabled', false, NOW),
      serviceAssignment: { server: true, agentExecution: false },
    },
    { ...machine('revoked', false, NOW), revokedAt: 'revoked' },
    { ...machine('superseded', false, NOW), supersededBy: base.id },
    { ...machine('bad-date', false, NOW), lastSeenAt: 'unknown' },
    { ...machine('old', false, NOW - WEEK - 1) },
  ]
  let answer: HeaderRows['machine'][] = []
  const stop = autorun(() => {
    answer = headerView(pool).offlineMachines()
  })
  try {
    headerEntities(pool).apply(
      [base, b, ...excluded].map((value) => ({ kind: 'machine', id: value.id, value })),
    )
    expect(answer).toEqual([base, b])
    runInAction(() => headerEntities(pool).order('machine', ['missing', 'b', 'b']))
    expect(answer).toEqual([b, base])
    runInAction(() => headerEntities(pool).order('machine', []))
    expect(answer).toEqual([base, b])
    headerEntities(pool).apply([{ kind: 'hostMetric', id: 'sample', value: metric('a') }])
    expect(answer).toEqual([b])
    headerEntities(pool).apply([{ kind: 'hostMetric', id: 'sample', value: metric('b') }])
    expect(answer).toEqual([base])
    headerEntities(pool).apply([{ kind: 'machine', id: 'a', value: undefined }])
    headerEntities(pool).apply([
      { kind: 'machine', id: 'a', value: base },
      { kind: 'hostMetric', id: 'sample', value: undefined },
    ])
    expect(answer).toEqual([b, base])
    runInAction(() => headerEntities(pool).clear())
    expect(answer).toEqual([])
    headerEntities(pool).apply([{ kind: 'machine', id: 'a', value: base }])
    expect(answer).toEqual([base])
  } finally {
    stop()
    pool.dispose()
  }
})
