import { describe, expect, it } from 'vitest'
import type { ChildLifecycleReport, LifecycleRole } from './lifecycle-channel'
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
  isSuccessorObservedHealthy,
  machineServiceReport,
  markPostUpdate,
  markRollbackUnavailable,
  POST_UPDATE_CRASH_LOOP_THRESHOLD,
  proveOwnStack,
  rollbackDecision,
  type SupervisedChild,
  spawnShapeFault,
  watchdogPetDecision,
} from './parent-supervisor'

const OBSERVED_AT = '2026-08-26T12:00:00.000Z'

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

describe('machineServiceReport', () => {
  it('reports a refused daemon as degraded while the server stays available', () => {
    let snap = emptyParentSnapshot('running')
    snap = applyChildRunning(snap, 'server', 10)
    snap = applyChildRunning(snap, 'daemon', 11)
    snap = applyChildExit(snap, 'daemon', {
      exitCode: CHILD_REFUSAL_EXIT_CODE,
      nowMs: 1_000,
      reason: 'daemon configuration refused',
    })

    expect(
      machineServiceReport({
        snap,
        assignment: { server: true, agentExecution: true },
        running: { server: true, agentExecution: true },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual({
      server: { policy: 'enabled', state: 'available', observedAt: OBSERVED_AT },
      agentExecution: {
        policy: 'enabled',
        state: 'refused',
        reason: 'daemon configuration refused',
        observedAt: OBSERVED_AT,
      },
    })
  })

  it('reports the disable-only lockout and a pending assignment change distinctly', () => {
    const report = machineServiceReport({
      snap: emptyParentSnapshot('running'),
      assignment: { server: true, agentExecution: true },
      running: { server: false, agentExecution: false },
      agentExecutionLockout: true,
      observedAt: OBSERVED_AT,
    })

    expect(report.server).toMatchObject({
      policy: 'enabled',
      state: 'stopped',
      reason: 'changes on restart',
    })
    expect(report.agentExecution).toMatchObject({
      policy: 'enabled',
      state: 'refused',
      reason: 'refused by local policy',
    })
    expect(report.agentExecutionLockout).toBe(true)
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
  const proved = {
    proved: true as const,
    stack: { server: { pid: 41, port: 4173 }, daemon: { pid: 42 } },
  }
  const unproved = {
    proved: false as const,
    refusal: { child: 'server' as const, because: 'silent' as const },
  }

  it("needs this parent's OWN children proved and the local daemon connected", () => {
    expect(isHandoverHealthy(proved, { daemonConnected: true })).toBe(true)
    expect(isHandoverHealthy(proved, { daemonConnected: false })).toBe(false)
  })

  /**
   * The whole point of POD-3762: a server answering /version with the target
   * version, and a daemon connected to it, prove nothing about WHOSE stack that
   * is. Only the successor's own children can, and here they have not.
   */
  it('a serving port and a connected daemon cannot stand in for our own children', () => {
    expect(isHandoverHealthy(unproved, { daemonConnected: true })).toBe(false)
  })

  it('a daemonless shape is judged on its own children alone (POD-2732)', () => {
    expect(
      isHandoverHealthy(
        { proved: true, stack: { server: { pid: 41, port: 4173 } } },
        { daemonConnected: false },
        {
          requiresDaemon: false,
        },
      ),
    ).toBe(true)
    expect(isHandoverHealthy(unproved, { daemonConnected: false }, { requiresDaemon: false })).toBe(
      false,
    )
  })
})

/**
 * What the OUTGOING parent can see: it has no line to the successor's children,
 * so it corroborates over HTTP and trusts the successor's own gate, which is
 * what writes supervisor-ready.json.
 */
describe('isSuccessorObservedHealthy', () => {
  it('requires the new version and, on a daemon-bearing shape, a connected daemon', () => {
    expect(
      isSuccessorObservedHealthy(
        { serverRunning: true, serverVersion: '1.2.3', daemonConnected: true },
        '1.2.3',
      ),
    ).toBe(true)
    expect(
      isSuccessorObservedHealthy(
        { serverRunning: true, serverVersion: '1.2.3', daemonConnected: false },
        '1.2.3',
      ),
    ).toBe(false)
    expect(
      isSuccessorObservedHealthy(
        { serverRunning: true, serverVersion: '1.2.2', daemonConnected: true },
        '1.2.3',
      ),
    ).toBe(false)
  })

  it('a server with no daemon down is not healthy just because the port answers', () => {
    expect(
      isSuccessorObservedHealthy(
        { serverRunning: false, serverVersion: '1.2.3', daemonConnected: true },
        '1.2.3',
      ),
    ).toBe(false)
  })
})

describe('handover phases', () => {
  it('marks outgoing handover with the expected version', () => {
    const snap = beginHandoverOutgoing(emptyParentSnapshot('running'), '9.9.9')
    expect(snap.phase).toBe('handover_outgoing')
    expect(snap.expectedVersion).toBe('9.9.9')
    expect(componentsProjection(snap).parent).toBe('handover')
  })
})

/**
 * POD-3762. The gate's evidence is now what THIS parent's own children said on
 * their private lines. Every case here is one way a stack can look serving from
 * outside while the successor's own children have proved nothing.
 */
describe('proveOwnStack', () => {
  const ready = (
    role: LifecycleRole,
    version: string,
    extra: { port?: number } = {},
  ): ChildLifecycleReport => ({
    channel: 'open',
    ready: { role, pid: role === 'server' ? 41 : 42, version, atMs: 1_000, ...extra },
  })
  const both = (version: string): Partial<Record<SupervisedChild, ChildLifecycleReport>> => ({
    server: ready('server', version, { port: 4173 }),
    daemon: ready('daemon', version),
  })

  it('proves the stack from ready frames, and carries the pid and port they named', () => {
    const verdict = proveOwnStack({
      lifecycle: both('2.0.0'),
      supervises: ['server', 'daemon'],
      expectedVersion: '2.0.0',
    })
    expect(verdict).toEqual({
      proved: true,
      stack: { server: { pid: 41, port: 4173 }, daemon: { pid: 42 } },
    })
  })

  /** The defect this issue exists for: the port answers, our own server has said nothing. */
  it('refuses while a supervised child has not reported ready', () => {
    const verdict = proveOwnStack({
      lifecycle: { server: { channel: 'open' }, daemon: ready('daemon', '2.0.0') },
      supervises: ['server', 'daemon'],
      expectedVersion: '2.0.0',
    })
    expect(verdict).toEqual({ proved: false, refusal: { child: 'server', because: 'silent' } })
  })

  it('refuses a child that has not been spawned at all', () => {
    expect(
      proveOwnStack({ lifecycle: {}, supervises: ['server'], expectedVersion: '2.0.0' }),
    ).toEqual({ proved: false, refusal: { child: 'server', because: 'not-spawned' } })
  })

  it('refuses a ready frame from the wrong version — the predecessor is not our child', () => {
    expect(
      proveOwnStack({
        lifecycle: both('1.0.0'),
        supervises: ['server', 'daemon'],
        expectedVersion: '2.0.0',
      }),
    ).toEqual({
      proved: false,
      refusal: { child: 'server', because: 'wrong-version', reported: '1.0.0', expected: '2.0.0' },
    })
  })

  it('accepts any version when the expected one is a dev build', () => {
    expect(
      proveOwnStack({ lifecycle: both('9.9.9'), supervises: ['server'], expectedVersion: 'dev' })
        .proved,
    ).toBe(true)
  })

  it('refuses a child whose line has closed since it reported ready', () => {
    expect(
      proveOwnStack({
        lifecycle: { server: { ...ready('server', '2.0.0', { port: 4173 }), channel: 'closed' } },
        supervises: ['server'],
        expectedVersion: '2.0.0',
      }),
    ).toEqual({ proved: false, refusal: { child: 'server', because: 'channel-closed' } })
  })

  it('refuses a child that is on its way out, however ready it once was', () => {
    expect(
      proveOwnStack({
        lifecycle: {
          server: {
            ...ready('server', '2.0.0', { port: 4173 }),
            stopping: { reason: 'asked', atMs: 2 },
          },
        },
        supervises: ['server'],
        expectedVersion: '2.0.0',
      }),
    ).toEqual({
      proved: false,
      refusal: { child: 'server', because: 'stopping', reason: 'asked' },
    })
  })

  it('refuses a server that reported ready without naming the port it bound', () => {
    expect(
      proveOwnStack({
        lifecycle: { server: ready('server', '2.0.0') },
        supervises: ['server'],
        expectedVersion: '2.0.0',
      }),
    ).toEqual({ proved: false, refusal: { child: 'server', because: 'no-port' } })
  })

  it('ignores a child this parent does not supervise', () => {
    expect(
      proveOwnStack({
        lifecycle: { server: ready('server', '2.0.0', { port: 4173 }) },
        supervises: ['server'],
        expectedVersion: '2.0.0',
      }).proved,
    ).toBe(true)
  })

  /**
   * POD-3774: a child spawned in a shape that cannot deliver a ready frame looks
   * exactly like a healthy-but-quiet one. The gate must say so at once rather
   * than spend its whole budget waiting for a frame that can never arrive.
   */
  it('names the spawn shape when the line could never have carried a frame', () => {
    expect(
      proveOwnStack({
        lifecycle: { server: { channel: 'none' } },
        supervises: ['server'],
        expectedVersion: '2.0.0',
        spawnFaults: { server: 'no-lifecycle-channel' },
      }),
    ).toEqual({
      proved: false,
      refusal: { child: 'server', because: 'unspawnable', fault: 'no-lifecycle-channel' },
    })
  })

  it('refuses a Windows child spawned attached, which dies with its supervisor unannounced', () => {
    expect(
      proveOwnStack({
        lifecycle: { server: ready('server', '2.0.0', { port: 4173 }) },
        supervises: ['server'],
        expectedVersion: '2.0.0',
        spawnFaults: { server: 'attached-on-windows' },
      }),
    ).toEqual({
      proved: false,
      refusal: { child: 'server', because: 'unspawnable', fault: 'attached-on-windows' },
    })
  })
})

describe('spawnShapeFault', () => {
  it('passes a child given the lifecycle line', () => {
    expect(spawnShapeFault({ stdio: ['ignore', 1, 1, 'ipc'] }, 'linux')).toBeUndefined()
    expect(spawnShapeFault({ stdio: 'ipc' }, 'linux')).toBeUndefined()
  })

  it('names a spawn with no line at all', () => {
    expect(spawnShapeFault({ stdio: 'inherit' }, 'linux')).toBe('no-lifecycle-channel')
    expect(spawnShapeFault({}, 'linux')).toBe('no-lifecycle-channel')
  })

  /** POD-3774: on Windows an attached child dies with the process that spawned it. */
  it('names an attached Windows spawn even when the line is there', () => {
    expect(spawnShapeFault({ stdio: ['ignore', 1, 1, 'ipc'] }, 'win32')).toBe('attached-on-windows')
    expect(
      spawnShapeFault({ stdio: ['ignore', 1, 1, 'ipc'], detached: true }, 'win32'),
    ).toBeUndefined()
  })

  it('does not ask a POSIX child to be detached', () => {
    expect(
      spawnShapeFault({ stdio: ['ignore', 1, 1, 'ipc'], detached: false }, 'darwin'),
    ).toBeUndefined()
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
