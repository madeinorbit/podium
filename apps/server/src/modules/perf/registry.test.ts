import { asSessionId } from '@podium/model'
import type { ClientSwitchTrace, PerfPrincipalRef } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { DEPLOYMENT, PerfRegistry } from './registry'

function trace(id: string): ClientSwitchTrace {
  return {
    switchId: id,
    startedAt: 1_000,
    sessionId: asSessionId('sess-1'),
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
    reg.record('rpc', 'sessions.list', 5, DEPLOYMENT, 100)
    reg.record('rpc', 'sessions.list', 15, DEPLOYMENT, 200)
    reg.record('phase', 'sessions.list', 999, DEPLOYMENT) // same name, other kind — separate bucket
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
    // 1..100 ms — nearest-rank percentiles are exact, including the POD-851
    // interaction gate's p95 target.
    for (let i = 1; i <= 100; i++) reg.record('phase', 'op', i, DEPLOYMENT)
    const summary = reg.snapshot().phases.op!
    expect(summary.p50Ms).toBe(50)
    expect(summary.p90Ms).toBe(90)
    expect(summary.p95Ms).toBe(95)
    expect(summary.p99Ms).toBe(99)
    expect(summary.maxMs).toBe(100)
  })

  it('bounds the sample ring: percentiles reflect only the most recent 512', () => {
    const reg = new PerfRegistry()
    // 512 slow samples fully displaced by 512 fast ones.
    for (let i = 0; i < 512; i++) reg.record('rpc', 'op', 1_000, DEPLOYMENT)
    for (let i = 0; i < 512; i++) reg.record('rpc', 'op', 1, DEPLOYMENT)
    const summary = reg.snapshot().rpc.op!
    expect(summary.count).toBe(1024) // count is lifetime, not ring-bounded
    expect(summary.p50Ms).toBe(1)
    expect(summary.p99Ms).toBe(1)
    expect(summary.maxMs).toBe(1_000) // max is lifetime too
  })

  it('bounds the client trace ring at 100, newest last', () => {
    const reg = new PerfRegistry()
    for (let i = 0; i < 150; i++) reg.pushClientTrace(trace(`s${i}`), DEPLOYMENT)
    const { clientSwitches } = reg.snapshot()
    expect(clientSwitches).toHaveLength(100)
    expect(clientSwitches[0]!.switchId).toBe('s50')
    expect(clientSwitches[99]!.switchId).toBe('s149')
  })

  it('reset clears everything and re-stamps sinceAt', () => {
    const reg = new PerfRegistry()
    const before = reg.snapshot().sinceAt
    reg.record('rpc', 'op', 5, DEPLOYMENT)
    reg.pushClientTrace(trace('s1'), DEPLOYMENT)
    reg.reset()
    const snap = reg.snapshot()
    expect(snap.rpc).toEqual({})
    expect(snap.phases).toEqual({})
    expect(snap.clientSwitches).toEqual([])
    expect(snap.sinceAt).toBeGreaterThanOrEqual(before)
  })

  it('an empty registry snapshots cleanly', () => {
    const snap = new PerfRegistry().snapshot()
    expect(snap).toMatchObject({ rpc: {}, phases: {}, clientSwitches: [], byPrincipal: {} })
  })
})

// ---------------------------------------------------------------------------
// POD-736 — the two dimensions that make a post-cutover A/B mean anything
// ---------------------------------------------------------------------------

const ALICE: PerfPrincipalRef = { digest: 'aaaa0000aaaa0000', kind: 'user' }
const BOB: PerfPrincipalRef = { digest: 'bbbb1111bbbb1111', kind: 'agent' }

describe('PerfRegistry per-principal dimension [POD-736]', () => {
  it('partitions samples by principal while leaving the deployment-wide aggregate whole', () => {
    const reg = new PerfRegistry()
    reg.record('phase', 'feedPublish.total', 10, ALICE)
    reg.record('phase', 'feedPublish.total', 30, BOB)
    const snap = reg.snapshot()
    // The aggregate still sees BOTH — this is the shape every recorded POD-701
    // baseline is in, and re-scoping it would strand them.
    expect(snap.phases['feedPublish.total']).toMatchObject({ count: 2, maxMs: 30 })
    // …and each principal sees only its own.
    expect(snap.byPrincipal[ALICE.digest]?.phases['feedPublish.total']).toMatchObject({
      count: 1,
      lastMs: 10,
    })
    expect(snap.byPrincipal[BOB.digest]?.phases['feedPublish.total']).toMatchObject({
      count: 1,
      lastMs: 30,
    })
  })

  it('keeps DEPLOYMENT work OUT of the principal table rather than inventing a principal for it', () => {
    const reg = new PerfRegistry()
    reg.record('phase', 'changeLogPrune.total', 7, DEPLOYMENT)
    const snap = reg.snapshot()
    // Positive control FIRST: the sample was really recorded, so the absence
    // below is an absence and not an empty registry.
    expect(snap.phases['changeLogPrune.total']).toMatchObject({ count: 1 })
    expect(Object.keys(snap.byPrincipal)).toEqual([])
  })

  it('records slice size at bootstrap, and says when it has never measured one', () => {
    const reg = new PerfRegistry()
    reg.record('phase', 'feedPublish.total', 1, ALICE)
    // A principal with samples but no bootstrap yet: `samples: 0` is what
    // distinguishes "not measured" from "measured, and the world was empty".
    expect(reg.snapshot().byPrincipal[ALICE.digest]?.sliceSize).toEqual({
      last: 0,
      min: 0,
      max: 0,
      samples: 0,
    })
    reg.observeSliceSize(ALICE, 530)
    reg.observeSliceSize(ALICE, 41)
    expect(reg.snapshot().byPrincipal[ALICE.digest]?.sliceSize).toEqual({
      last: 41,
      min: 41,
      max: 530,
      samples: 2,
    })
  })

  it('an empty world is reported as 0 with samples: 1, not as unmeasured', () => {
    const reg = new PerfRegistry()
    reg.observeSliceSize(BOB, 0)
    expect(reg.snapshot().byPrincipal[BOB.digest]?.sliceSize).toEqual({
      last: 0,
      min: 0,
      max: 0,
      samples: 1,
    })
  })

  it('a scoped read returns ONE principal’s traces and none of the other’s', () => {
    const reg = new PerfRegistry()
    reg.pushClientTrace(trace('alice-switch'), ALICE)
    reg.pushClientTrace(trace('bob-switch'), BOB)
    const scoped = reg.snapshotFor(ALICE)
    // The YES arm, so the NO arm below cannot pass vacuously.
    expect(scoped?.clientSwitches.map((t) => t.switchId)).toEqual(['alice-switch'])
    expect(scoped?.clientSwitches.some((t) => t.switchId === 'bob-switch')).toBe(false)
    // …and the deployment-wide read still carries both, which is exactly why it
    // is declared admin-grade rather than served to every member.
    expect(reg.snapshot().clientSwitches).toHaveLength(2)
  })

  it('snapshotFor a principal that was never recorded is undefined, not an empty slice', () => {
    const reg = new PerfRegistry()
    reg.record('phase', 'feedPublish.total', 1, ALICE)
    expect(reg.snapshotFor(ALICE)).toBeDefined()
    expect(reg.snapshotFor(BOB)).toBeUndefined()
  })

  it('reset clears the principal partitions too', () => {
    const reg = new PerfRegistry()
    reg.record('phase', 'feedPublish.total', 1, ALICE)
    reg.observeSliceSize(ALICE, 12)
    expect(reg.snapshot().byPrincipal[ALICE.digest]).toBeDefined()
    reg.reset()
    expect(reg.snapshot().byPrincipal).toEqual({})
  })
})
