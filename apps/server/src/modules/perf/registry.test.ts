import type { ClientSwitchTrace } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { PerfRegistry } from './registry'

function trace(id: string): ClientSwitchTrace {
  return {
    switchId: id,
    startedAt: 1_000,
    sessionId: 'sess-1',
    mode: 'chat',
    cold: false,
    totalMs: 42,
    timedOut: false,
    marks: [{ name: 'attach', atMs: 10 }],
  }
}

describe('PerfRegistry', () => {
  it('aggregates count/last/max/totalBytes per op, keyed by kind + name', () => {
    const reg = new PerfRegistry()
    reg.record('rpc', 'sessions.list', 5, 100)
    reg.record('rpc', 'sessions.list', 15, 200)
    reg.record('phase', 'sessions.list', 999) // same name, other kind — separate bucket
    const snap = reg.snapshot()
    expect(snap.rpc['sessions.list']).toMatchObject({
      count: 2,
      lastMs: 15,
      maxMs: 15,
      totalBytes: 300,
    })
    expect(snap.phases['sessions.list']).toMatchObject({ count: 1, lastMs: 999, maxMs: 999 })
  })

  it('computes percentiles over recent samples at snapshot time', () => {
    const reg = new PerfRegistry()
    // 1..100 ms — nearest-rank percentiles are exact: p50=50, p90=90, p99=99.
    for (let i = 1; i <= 100; i++) reg.record('phase', 'op', i)
    const summary = reg.snapshot().phases.op!
    expect(summary.p50Ms).toBe(50)
    expect(summary.p90Ms).toBe(90)
    expect(summary.p99Ms).toBe(99)
    expect(summary.maxMs).toBe(100)
  })

  it('bounds the sample ring: percentiles reflect only the most recent 512', () => {
    const reg = new PerfRegistry()
    // 512 slow samples fully displaced by 512 fast ones.
    for (let i = 0; i < 512; i++) reg.record('rpc', 'op', 1_000)
    for (let i = 0; i < 512; i++) reg.record('rpc', 'op', 1)
    const summary = reg.snapshot().rpc.op!
    expect(summary.count).toBe(1024) // count is lifetime, not ring-bounded
    expect(summary.p50Ms).toBe(1)
    expect(summary.p99Ms).toBe(1)
    expect(summary.maxMs).toBe(1_000) // max is lifetime too
  })

  it('bounds the client trace ring at 100, newest last', () => {
    const reg = new PerfRegistry()
    for (let i = 0; i < 150; i++) reg.pushClientTrace(trace(`s${i}`))
    const { clientSwitches } = reg.snapshot()
    expect(clientSwitches).toHaveLength(100)
    expect(clientSwitches[0]!.switchId).toBe('s50')
    expect(clientSwitches[99]!.switchId).toBe('s149')
  })

  it('reset clears everything and re-stamps sinceAt', () => {
    const reg = new PerfRegistry()
    const before = reg.snapshot().sinceAt
    reg.record('rpc', 'op', 5)
    reg.pushClientTrace(trace('s1'))
    reg.reset()
    const snap = reg.snapshot()
    expect(snap.rpc).toEqual({})
    expect(snap.phases).toEqual({})
    expect(snap.clientSwitches).toEqual([])
    expect(snap.sinceAt).toBeGreaterThanOrEqual(before)
  })

  it('an empty registry snapshots cleanly', () => {
    const snap = new PerfRegistry().snapshot()
    expect(snap).toMatchObject({ rpc: {}, phases: {}, clientSwitches: [] })
  })
})
