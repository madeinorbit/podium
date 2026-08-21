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
  clearPostUpdate,
  componentsProjection,
  crashBackoffMs,
  emptyParentSnapshot,
  isHandoverHealthy,
  isPostUpdateCrashLoop,
  markPostUpdate,
  markRollbackUnavailable,
  POST_UPDATE_CRASH_LOOP_THRESHOLD,
  rollbackDecision,
  watchdogPetDecision,
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
    expect(snap.children.server).toMatchObject({
      status: 'restarting',
      attempts: 0,
      nextAtMs: 6_000,
    })
    expect(snap.postUpdateCrashes).toEqual([5_000])

    snap = applyChildExit(snap, 'server', { exitCode: 1, nowMs: 6_500 })
    expect(snap.children.server).toMatchObject({
      status: 'restarting',
      attempts: 1,
      nextAtMs: 8_500,
    })
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
          serverVersion: '1.2.2',
          daemonConnected: true,
        },
        '1.2.3',
      ),
    ).toBe(false)
  })

  it('a server with no daemon down is not healthy just because the port answers', () => {
    expect(
      isHandoverHealthy(
        { serverRunning: false, serverVersion: '1.2.3', daemonConnected: true },
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

  /**
   * Re-review R1. A parent that does not KNOW must not act as if the answer were
   * "no migrations": restoring old code over a migrated database corrupts data.
   * The successor read `undefined` and, because the call site coerced it with
   * `=== true`, rolled back across migrating releases.
   */
  it('refuses, and says so, when the migration fact is UNKNOWN rather than false', () => {
    const d = rollbackDecision({
      crashLoop: true,
      oldBundlePresent: true,
      releaseHadMigrations: undefined,
    })
    expect(d).toMatchObject({ action: 'unavailable' })
    if (d.action === 'unavailable') expect(d.why).toMatch(/cannot tell/)
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

describe('markRollbackUnavailable', () => {
  /**
   * A stuck release is not a per-child condition, and the first cut modelled it
   * as a bare `phase = 'degraded'` — which the very next child coming up wiped,
   * because `applyChildRunning` promotes a degraded parent with no refusals back
   * to running. The machine then looked healthy while sitting on a release
   * nobody could undo.
   */
  it('survives a child coming back up, and says why', () => {
    const stuck = markRollbackUnavailable(
      applyChildRunning(emptyParentSnapshot('running'), 'server', 11),
      'rollback unavailable: release carried schema migrations — forward-fix required',
    )
    expect(stuck.phase).toBe('degraded')

    const afterRestart = applyChildRunning(stuck, 'server', 12)
    expect(afterRestart.phase, 'a healthy child must not un-stick the release').toBe('degraded')
    expect(componentsProjection(afterRestart).rollbackUnavailable).toMatch(/migrations/)
  })

  it('is cleared when the post-update window closes', () => {
    const stuck = markRollbackUnavailable(emptyParentSnapshot('running'), 'no .old bundle')
    expect(clearPostUpdate(stuck).rollbackUnavailable).toBeUndefined()
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

describe('watchdogPetDecision', () => {
  const wedgedAfterMs = 10_000

  it('pets when no component reports an advance token', () => {
    expect(watchdogPetDecision({ advance: {}, nowMs: 0, wedgedAfterMs }).pet).toBe(true)
  })

  it('pets for a DEGRADED or STOPPED janitor — degraded never bubbles to systemd', () => {
    for (const state of ['degraded', 'stopped'] as const) {
      const decision = watchdogPetDecision({
        janitor: { state, progressVersion: 7 },
        advance: { progress: 7, observedAtMs: 0 },
        nowMs: 10 * wedgedAfterMs,
        wedgedAfterMs,
      })
      expect(decision.pet, `${state} must still pet`).toBe(true)
      expect(decision.wedged).toBe(false)
    }
  })

  it('pets while a running janitor advances, and records the new token', () => {
    const first = watchdogPetDecision({
      janitor: { state: 'running', progressVersion: 1 },
      advance: {},
      nowMs: 1_000,
      wedgedAfterMs,
    })
    expect(first).toMatchObject({ pet: true, wedged: false })
    expect(first.advance).toEqual({ progress: 1, observedAtMs: 1_000 })

    const advanced = watchdogPetDecision({
      janitor: { state: 'running', progressVersion: 2 },
      advance: first.advance,
      nowMs: 60_000,
      wedgedAfterMs,
    })
    expect(advanced).toMatchObject({ pet: true, wedged: false })
    expect(advanced.advance).toEqual({ progress: 2, observedAtMs: 60_000 })
  })

  it('WITHHOLDS the pet for a janitor that says running while its token is frozen', () => {
    const advance = { progress: 5, observedAtMs: 1_000 }
    const stillFine = watchdogPetDecision({
      janitor: { state: 'running', progressVersion: 5 },
      advance,
      nowMs: 1_000 + wedgedAfterMs - 1,
      wedgedAfterMs,
    })
    expect(stillFine.pet).toBe(true)

    const wedged = watchdogPetDecision({
      janitor: { state: 'running', progressVersion: 5 },
      advance,
      nowMs: 1_000 + wedgedAfterMs,
      wedgedAfterMs,
    })
    expect(wedged).toMatchObject({ pet: false, wedged: true })
  })
})
