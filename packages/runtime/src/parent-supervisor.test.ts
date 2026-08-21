import { describe, expect, it } from 'vitest'
import {
  applyChildExit,
  applyChildRunning,
  applyJanitorRefusal,
  beginHandoverOutgoing,
  CHILD_REFUSAL_EXIT_CODE,
  CHILD_START_ORDER,
  classifyChildExit,
  clearJanitorRefusal,
  componentsProjection,
  crashBackoffMs,
  emptyParentSnapshot,
  isHandoverHealthy,
  isPostUpdateCrashLoop,
  markPostUpdate,
  POST_UPDATE_CRASH_LOOP_THRESHOLD,
  rollbackDecision,
} from './parent-supervisor'

describe('classifyChildExit', () => {
  it('treats exit 78 as refusal and signals as crash', () => {
    expect(classifyChildExit({ exitCode: CHILD_REFUSAL_EXIT_CODE })).toBe('refusal')
    expect(classifyChildExit({ exitCode: 1 })).toBe('crash')
    expect(classifyChildExit({ exitCode: 0 })).toBe('crash')
    expect(classifyChildExit({ exitCode: null, signal: 'SIGKILL' })).toBe('crash')
  })
})

describe('crashBackoffMs', () => {
  it('climbs the ladder then caps', () => {
    expect(crashBackoffMs(0)).toBe(1_000)
    expect(crashBackoffMs(1)).toBe(2_000)
    expect(crashBackoffMs(4)).toBe(30_000)
    expect(crashBackoffMs(99)).toBe(30_000)
  })
})

describe('applyChildExit', () => {
  it('parks a refusal as degraded without scheduling restart', () => {
    let snap = emptyParentSnapshot('running')
    snap = applyChildRunning(snap, 'server', 10)
    snap = applyChildRunning(snap, 'daemon', 11)
    snap = applyChildExit(snap, 'daemon', {
      exitCode: CHILD_REFUSAL_EXIT_CODE,
      nowMs: 1_000,
      reason: 'schema regression',
    })
    expect(snap.phase).toBe('degraded')
    expect(snap.children.daemon).toEqual({
      status: 'refused',
      reason: 'schema regression',
      exitCode: CHILD_REFUSAL_EXIT_CODE,
    })
    expect(snap.refusals.daemon).toBe('schema regression')
    expect(snap.children.server.status).toBe('running')
  })

  it('schedules crash restart with backoff and counts post-update crashes', () => {
    let snap = markPostUpdate(emptyParentSnapshot('running'), 0)
    snap = applyChildRunning(snap, 'server', 10)
    snap = applyChildExit(snap, 'server', { exitCode: 1, nowMs: 5_000 })
    expect(snap.children.server).toMatchObject({ status: 'restarting', attempts: 0, nextAtMs: 6_000 })
    expect(snap.postUpdateCrashes).toEqual([5_000])

    snap = applyChildExit(snap, 'server', { exitCode: 1, nowMs: 6_500 })
    expect(snap.children.server).toMatchObject({ status: 'restarting', attempts: 1, nextAtMs: 8_500 })
  })
})

describe('janitor refusal projection', () => {
  it('surfaces janitor degraded while server stays running', () => {
    let snap = emptyParentSnapshot('running')
    snap = applyChildRunning(snap, 'server', 1)
    snap = applyChildRunning(snap, 'daemon', 2)
    snap = applyJanitorRefusal(snap, 'maintenance schema incompatible')
    const proj = componentsProjection(snap)
    expect(proj.parent).toBe('degraded')
    expect(proj.janitor).toBe('degraded')
    expect(proj.degraded).toEqual(['janitor'])
    expect(proj.server).toBe('running')
    snap = clearJanitorRefusal(snap)
    expect(componentsProjection(snap).parent).toBe('running')
  })
})

describe('handover health gate', () => {
  it('requires both children, new /version, and daemon connected — not bare /health', () => {
    expect(
      isHandoverHealthy(
        {
          serverRunning: true,
          daemonRunning: true,
          serverVersion: '1.2.3',
          daemonConnected: true,
        },
        '1.2.3',
      ),
    ).toBe(true)
    expect(
      isHandoverHealthy(
        {
          serverRunning: true,
          daemonRunning: true,
          serverVersion: '1.2.3',
          daemonConnected: false,
        },
        '1.2.3',
      ),
    ).toBe(false)
    expect(
      isHandoverHealthy(
        {
          serverRunning: true,
          daemonRunning: true,
          serverVersion: '1.2.2',
          daemonConnected: true,
        },
        '1.2.3',
      ),
    ).toBe(false)
  })

  it('marks outgoing handover with the expected version', () => {
    const snap = beginHandoverOutgoing(emptyParentSnapshot('running'), '9.9.9')
    expect(snap.phase).toBe('handover_outgoing')
    expect(snap.expectedVersion).toBe('9.9.9')
    expect(componentsProjection(snap).parent).toBe('handover')
  })
})

describe('rollbackDecision', () => {
  it('rolls back on crash-loop only when .old exists and release had no migrations', () => {
    expect(
      rollbackDecision({
        crashLoop: true,
        oldBundlePresent: true,
        releaseHadMigrations: false,
      }),
    ).toEqual({ action: 'rollback' })
  })

  it('reports WHY when migrations block rollback', () => {
    const d = rollbackDecision({
      crashLoop: true,
      oldBundlePresent: true,
      releaseHadMigrations: true,
    })
    expect(d).toMatchObject({ action: 'unavailable' })
    if (d.action === 'unavailable') expect(d.why).toMatch(/migrations/)
  })

  it('reports WHY when .old is missing', () => {
    const d = rollbackDecision({
      crashLoop: true,
      oldBundlePresent: false,
      releaseHadMigrations: false,
    })
    expect(d).toMatchObject({ action: 'unavailable' })
    if (d.action === 'unavailable') expect(d.why).toMatch(/\.old/)
  })

  it('continues when the crash-loop threshold is not met', () => {
    expect(
      rollbackDecision({
        crashLoop: false,
        oldBundlePresent: true,
        releaseHadMigrations: false,
      }),
    ).toEqual({ action: 'continue' })
  })
})

describe('isPostUpdateCrashLoop', () => {
  it('trips after the threshold inside the window', () => {
    let snap = markPostUpdate(emptyParentSnapshot('running'), 0)
    for (let i = 0; i < POST_UPDATE_CRASH_LOOP_THRESHOLD; i++) {
      snap = applyChildRunning(snap, 'server', 100 + i)
      snap = applyChildExit(snap, 'server', { exitCode: 1, nowMs: 1_000 + i * 100 })
    }
    expect(isPostUpdateCrashLoop(snap, 2_000)).toBe(true)
  })
})

describe('CHILD_START_ORDER', () => {
  it('starts server before daemon', () => {
    expect(CHILD_START_ORDER).toEqual(['server', 'daemon'])
  })
})
