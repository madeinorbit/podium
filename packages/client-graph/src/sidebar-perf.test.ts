import {
  beginSidebarCheck,
  beginSidebarUpdate,
  bindSidebarPerf,
  createSidebarPerf,
  reportSidebarCheck,
} from '@podium/client-core/perf'
import { autorun, computed, observable, Reaction, runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { MobxPool } from './pool'
import { measureWorklistPoolDelivery, observeWorklistPoolPerf } from './sidebar-perf'

const stops: Array<() => void> = []
afterEach(() => {
  stops.reverse().forEach((stop) => stop())
  stops.length = 0
})

function fixture() {
  const owner = {}
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 1000 })
  stops.push(() => pool.dispose())
  stops.push(observeWorklistPoolPerf(owner, pool))
  const perf = createSidebarPerf()
  return { owner, pool, perf }
}

describe('outside pool telemetry', () => {
  it('replays residency on late panel open and maintains only resident slots without reading rows', () => {
    const { owner, pool, perf } = fixture()
    const unreadable = new Proxy(
      {},
      {
        get() {
          throw new Error('telemetry read a row')
        },
      },
    )
    runInAction(() => pool.tables.repo.set('resident', unreadable))
    stops.push(bindSidebarPerf(owner, perf))
    expect(perf.read().pool).toEqual({ connected: true, rows: 1 })
    runInAction(() =>
      pool.tables.repo.set(
        'resident',
        new Proxy(
          {},
          {
            get() {
              throw new Error('telemetry read an updated row')
            },
          },
        ),
      ),
    )
    expect(perf.read().pool.rows).toBe(1)
    runInAction(() => pool.tables.repo.set('second', unreadable))
    expect(perf.read().pool.rows).toBe(2)
    runInAction(() => pool.tables.repo.delete('resident'))
    expect(perf.read().pool.rows).toBe(1)
    const before = perf.read()
    for (let i = 0; i < 100; i++) expect(perf.read().idle).toEqual(before.idle)
    stops[1]!()
    expect(perf.read().pool).toEqual({ connected: false, rows: null })
    runInAction(() => pool.tables.repo.set('after-dispose', unreadable))
    expect(perf.read().pool.connected).toBe(false)
  })

  it('counts executed computed and reaction bodies, including an unchanged answer, only while open', () => {
    const { owner, perf } = fixture()
    const originalCompute = Object.getPrototypeOf(computed(() => 0)).computeValue_
    const originalTrack = Reaction.prototype.track
    const close = bindSidebarPerf(owner, perf)
    stops.push(close)
    const input = observable.box(0)
    const value = computed(() => input.get() % 2)
    const stop = autorun(() => {
      value.get()
    })
    stops.push(stop)
    const before = perf.read().idle.derivations
    expect(before).toBe(2)
    runInAction(() => input.set(2))
    expect(perf.read().idle.derivations).toBe(before + 1)
    close()
    expect(Object.getPrototypeOf(value).computeValue_).toBe(originalCompute)
    expect(Reaction.prototype.track).toBe(originalTrack)
    runInAction(() => input.set(3))
    expect(perf.read().idle.derivations).toBe(before + 1)
    stops.push(bindSidebarPerf(owner, perf))
    runInAction(() => input.set(4))
    expect(perf.read().idle.derivations).toBeGreaterThan(before + 1)
  })

  it('leaves an empty deadline tick at zero and counts deliberate checker work separately', () => {
    const { owner, pool, perf } = fixture()
    stops.push(bindSidebarPerf(owner, perf))
    pool.applyLocals({ selectedIssueId: null, coarseNow: 2000 }, new Set(['coarseNow']))
    expect(perf.read().idle).toEqual({ rows: 0, derivations: 0, mainThreadMs: 0 })
    const end = beginSidebarCheck(owner)
    const stop = autorun(() => {
      pool.groups.keys
    })
    end()
    stop()
    reportSidebarCheck(owner, { state: 'match', differences: 0, checkedAt: 2000 })
    expect(perf.read().idle).toEqual({ rows: 0, derivations: 0, mainThreadMs: 0 })
    expect(perf.read().checkWork.derivations).toBeGreaterThan(0)
    expect(perf.read().check.state).toBe('match')
  })

  it('attributes the existing feed delivery through paint and preserves throwing delivery behavior', () => {
    const { owner, pool, perf } = fixture()
    const paints: Array<() => void> = []
    stops.push(bindSidebarPerf(owner, perf, (done) => paints.push(done)))
    const finish = beginSidebarUpdate(owner, ['issues'])!
    measureWorklistPoolDelivery(owner, () => {
      runInAction(() => pool.tables.repo.set('resident', {}))
      perf.record({ rows: 1 })
    })
    finish()
    expect(perf.read().lastUpdate?.pending).toBe(true)
    paints.splice(0).forEach((done) => done())
    expect(perf.read().lastUpdate).toMatchObject({
      changed: ['issues'],
      pending: false,
      work: { rows: 1 },
    })
    expect(perf.read().lastUpdate!.work.mainThreadMs).toBeGreaterThan(0)
    expect(perf.read().idle.rows).toBe(0)
    const beforeFailure = perf.read().idle.mainThreadMs
    expect(() =>
      measureWorklistPoolDelivery(owner, () => {
        throw new Error('delivery failed')
      }),
    ).toThrow('delivery failed')
    expect(perf.read().idle.mainThreadMs).toBeGreaterThan(beforeFailure)
    expect(perf.read().pool.rows).toBe(1)
  })
})
