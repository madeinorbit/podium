import { asMachineId } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  decideReconciliation,
  MAX_RECONCILE_ATTEMPTS,
  type ReconcileFacts,
  type ReconcileRefusal,
  UpdateReconciler,
} from './reconciler'
import { UpdatesService } from './service'
import type { WaveMachine } from './wave'

/**
 * THE STANDING RECONCILIATION (POD-2105, spec §3.6).
 *
 * Two halves, tested as two: a PURE decision table — nine ways to say no and one
 * to say yes, none of which needs a fleet to reproduce — and the queue, driven
 * by a FAKE CLOCK. Nothing here sleeps; a `setTimeout` before an assertion is a
 * bug in this repo's unit lane and would also be the very defect this epic
 * removes from the product.
 */

// ───────────────────────────── fixtures ──────────────────────────────

const TARGET_VERSION = '0.4.3'

function target(over: Partial<UpdateTarget> = {}): UpdateTarget {
  return { version: TARGET_VERSION, critical: false, artifacts: {}, ...over } as UpdateTarget
}

/** The same target once it carries a packed tarball, which is what makes the
 *  delivery question answerable at all (an empty artifact set offers nothing). */
function packedTarget(): UpdateTarget {
  return target({ artifacts: { headless: { delivery: 'bundle', platforms: {} } } } as never)
}

function machine(over: Partial<WaveMachine> & { id: string }): WaveMachine {
  return { name: over.id, version: '0.4.1', state: 'current', online: true, busy: false, ...over }
}

const facts = (over: Partial<ReconcileFacts> = {}): ReconcileFacts => ({
  machine: machine({ id: 'laptop' }),
  target: target(),
  operationActive: false,
  attempts: 0,
  ...over,
})

/**
 * A fake clock that RUNS NOTHING until asked. The reconciler's spacing is the
 * only timer it owns, so "what happens next" is always an explicit `flush()` in
 * the test rather than a race with the event loop.
 */
function fakeClock() {
  const pending: Array<() => void> = []
  return {
    schedule: (fn: () => void) => {
      pending.push(fn)
    },
    /** Run every timer armed so far, once. */
    flush(): number {
      const due = pending.splice(0, pending.length)
      for (const fn of due) fn()
      return due.length
    },
    armed: () => pending.length,
  }
}

function harness(machines: WaveMachine[], over: { operationActive?: boolean } = {}) {
  const send = vi.fn()
  let grants = 0
  const live = machines
  const updates = new UpdatesService({
    machines: () => live,
    send,
    now: () => 1_000,
    nextGrantId: () => `g${++grants}`,
    concurrency: 3,
    fleetChannel: () => 'dev',
  })
  const clock = fakeClock()
  let operationActive = over.operationActive ?? false
  const reconciler = new UpdateReconciler({
    updates,
    operationActive: () => operationActive,
    schedule: clock.schedule,
    spacingMs: 5_000,
  })
  return {
    updates,
    reconciler,
    clock,
    send,
    live,
    setOperationActive: (value: boolean) => {
      operationActive = value
    },
    /** Which machine ids have been handed a grant so far. */
    granted: (): string[] => send.mock.calls.map((call) => String(call[0])),
    /** The live projection row for one machine — what the fleet payload holds. */
    row: (id: string): WaveMachine => {
      const found = updates.fleet().find((candidate) => candidate.id === id)
      if (!found) throw new Error(`no machine ${id} in the fleet`)
      return found
    },
  }
}

// ───────────────────────── the decision table ─────────────────────────

describe('decideReconciliation', () => {
  const rows: Array<{ name: string; over: Partial<ReconcileFacts>; because?: ReconcileRefusal }> = [
    {
      name: 'a reconnected machine behind the current target converges',
      over: {},
    },
    {
      /** The operation owns granting while it runs (§3.6, plan task 4). This is
       *  first in the function for a reason: it is a fact about the SERVER, and
       *  it holds whatever the machine looks like. */
      name: 'nothing is converged while an exclusive operation is active',
      over: { operationActive: true },
      because: 'operation-active',
    },
    {
      name: 'a machine that is gone from the fleet is nobody to converge',
      over: { machine: undefined },
      because: 'unknown-machine',
    },
    {
      name: 'no published target means nothing to converge to',
      over: { target: undefined },
      because: 'no-target',
    },
    {
      name: 'a machine already on the target is left alone',
      over: { machine: machine({ id: 'laptop', version: TARGET_VERSION }) },
      because: 'at-target',
    },
    {
      name: 'an offline machine is not granted anything',
      over: { machine: machine({ id: 'laptop', online: false }) },
      because: 'offline',
    },
    {
      /** The shell owns a supervised daemon's bytes; no fleet path may (§4, P5). */
      name: 'a desktop-supervised daemon is never the reconciler‘s to update',
      over: { machine: machine({ id: 'macbook', supervised: true }) },
      because: 'supervised',
    },
    {
      name: 'a machine that cannot take this delivery is not handed it anyway',
      over: {
        target: packedTarget(),
        machine: machine({ id: 'src', deliveryCaps: ['update.delivery.git'] }),
      },
      because: 'cannot-take-delivery',
    },
    {
      name: 'a machine already converging is not granted a second time',
      over: { machine: machine({ id: 'laptop', state: 'downloading' }) },
      because: 'in-flight',
    },
    {
      /** THE LOOP GUARD, as a decision rather than as a hope. */
      name: 'a machine that refused this update is left alone',
      over: { machine: machine({ id: 'laptop', state: 'rejected' }) },
      because: 'terminal',
    },
    {
      name: 'a machine that has taken its attempts is left alone',
      over: { attempts: MAX_RECONCILE_ATTEMPTS },
      because: 'attempts-exhausted',
    },
  ]

  for (const row of rows) {
    it(row.name, () => {
      const decision = decideReconciliation(facts(row.over))
      expect(decision).toEqual(
        row.because === undefined ? { converge: true } : { converge: false, because: row.because },
      )
    })
  }

  it('counts attempts against the target, so a new version starts fresh', () => {
    expect(decideReconciliation(facts({ attempts: MAX_RECONCILE_ATTEMPTS - 1 }))).toEqual({
      converge: true,
    })
  })
})

// ──────────────────────────── the queue ─────────────────────────────

describe('UpdateReconciler', () => {
  it('grants exactly one machine when it reconnects behind the target', () => {
    const h = harness([machine({ id: 'laptop' })])
    h.updates.setTarget('dev', target())

    h.reconciler.onMachineConnected('laptop')

    expect(h.granted()).toEqual(['laptop'])
  })

  it('grants nothing when the machine reconnects already at the target', () => {
    const h = harness([machine({ id: 'laptop', version: TARGET_VERSION })])
    h.updates.setTarget('dev', target())

    h.reconciler.onMachineConnected('laptop')

    expect(h.granted()).toEqual([])
  })

  /**
   * ONE AT A TIME, GLOBALLY (§3.6). Two daemons waking together is the ordinary
   * case after a power cut, and it must not become a wave nobody authorized.
   */
  it('converges reconnecting machines one at a time, spaced', () => {
    const h = harness([machine({ id: 'a' }), machine({ id: 'b' })])
    h.updates.setTarget('dev', target())

    h.reconciler.onMachineConnected('a')
    h.reconciler.onMachineConnected('b')
    expect(h.granted()).toEqual(['a'])
    expect(h.clock.armed()).toBe(1)

    // `a` is still downloading, so the second grant waits — and says so by
    // arming another timer rather than by silently dropping `b`.
    h.updates.onStatus(asMachineId('a'), {
      type: 'updateStatus',
      state: 'downloading',
      version: '0.4.1',
      grantId: 'g1',
    })
    h.clock.flush()
    expect(h.granted()).toEqual(['a'])
    expect(h.reconciler.pending()).toEqual(['b'])

    // …and once `a` is home, `b` gets its turn.
    h.updates.onStatus(asMachineId('a'), {
      type: 'updateStatus',
      state: 'current',
      version: TARGET_VERSION,
      grantId: 'g1',
    })
    h.live[0] = machine({ id: 'a', version: TARGET_VERSION })
    h.clock.flush()
    expect(h.granted()).toEqual(['a', 'b'])
  })

  /**
   * THE ACCEPTANCE CASE THE PLAN NAMES: a rejected machine is never re-granted
   * the same target by the reconciler. `authorizeMachine` CLEARS a terminal
   * state before planning — it is the human retry path — so a reconciler that
   * called it unconditionally would erase the refusal and hot-loop on every
   * reconnect.
   */
  it('never re-grants a machine that rejected this target', () => {
    const h = harness([machine({ id: 'laptop' })])
    h.updates.setTarget('dev', target())
    h.reconciler.onMachineConnected('laptop')
    expect(h.granted()).toEqual(['laptop'])

    h.updates.onStatus(asMachineId('laptop'), {
      type: 'updateStatus',
      state: 'rejected',
      version: '0.4.1',
      grantId: 'g1',
      detail: 'dirty working tree',
    })
    h.clock.flush()

    h.reconciler.onMachineConnected('laptop')
    h.reconciler.onMachineConnected('laptop')
    h.clock.flush()

    expect(h.granted()).toEqual(['laptop'])
  })

  /**
   * The other half of loop safety: a machine that neither converges nor refuses
   * — it reconnects still behind, having said nothing about why — is bounded by
   * ATTEMPTS rather than by hope.
   *
   * Driven against a stub fleet on purpose. The real service would age the
   * grant into `stuck` and the terminal check above would catch it long before
   * this counter did; a stub that reports the machine perpetually idle and
   * perpetually behind is the only way to put the counter itself under test —
   * which is exactly the case the counter exists for.
   */
  it('gives up on a machine that keeps reconnecting still behind', () => {
    const granted: string[] = []
    const behind = machine({ id: 'flapper' })
    const updates = {
      fleet: () => [behind],
      channelOf: () => 'dev' as const,
      target: () => target(),
      authorizeMachine: (id: string) => {
        granted.push(String(id))
        return { result: 'granted' as const, version: TARGET_VERSION }
      },
    } as unknown as UpdatesService
    const clock = fakeClock()
    const reconciler = new UpdateReconciler({
      updates,
      operationActive: () => false,
      schedule: clock.schedule,
      spacingMs: 5_000,
    })

    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS + 3; i += 1) {
      reconciler.onMachineConnected('flapper')
      clock.flush()
    }

    expect(granted).toEqual(Array<string>(MAX_RECONCILE_ATTEMPTS).fill('flapper'))
  })

  it('pauses while an operation is active and sweeps everyone still behind when it ends', () => {
    const h = harness([machine({ id: 'a' }), machine({ id: 'b' })], { operationActive: true })
    h.updates.setTarget('dev', target())

    h.reconciler.onMachineConnected('a')
    expect(h.granted()).toEqual([])
    // The machine is not FORGOTTEN, it is waiting — which is what makes the
    // sweep below a resumption rather than a lucky second reconnect.
    expect(h.reconciler.pending()).toEqual(['a'])

    h.setOperationActive(false)
    h.reconciler.onOperationSettled()

    expect(h.granted()).toEqual(['a'])
    expect(h.reconciler.pending()).toEqual(['b'])
  })

  /**
   * A CANCEL IS CONSENT BEING WITHDRAWN. The sweep's whole licence is that the
   * human decided when the operation started (§9.1); after a cancel there is no
   * such decision, and handing out the update seconds after someone stopped it
   * is the worst possible moment to be helpful.
   */
  it('does not sweep after a canceled operation', () => {
    const h = harness([machine({ id: 'a' }), machine({ id: 'b' })], { operationActive: true })
    h.updates.setTarget('dev', target())

    h.setOperationActive(false)
    h.reconciler.onOperationSettled('canceled')

    expect(h.granted()).toEqual([])
  })

  it('does sweep after a failed one, so nobody waits for a human to retry', () => {
    const h = harness([machine({ id: 'a' }), machine({ id: 'b' })], { operationActive: true })
    h.updates.setTarget('dev', target())

    h.setOperationActive(false)
    h.reconciler.onOperationSettled('failed')

    expect(h.granted()).toEqual(['a'])
  })

  /** §3.6 visibility: the fleet payload can say who moved a row that moved with
   *  nobody looking, and stops saying it once an operation takes over. */
  it('marks the machines it converged, and yields the label to an operation', () => {
    const h = harness([machine({ id: 'laptop' })])
    h.updates.setTarget('dev', target())

    h.reconciler.onMachineConnected('laptop')
    expect(h.reconciler.convergedBy(h.row('laptop'))).toBe('reconciler')

    h.reconciler.onOperationStarted()
    expect(h.reconciler.convergedBy(h.row('laptop'))).toBeUndefined()
  })

  it('does not label a machine whose target has since moved on', () => {
    const h = harness([machine({ id: 'laptop' })])
    h.updates.setTarget('dev', target())
    h.reconciler.onMachineConnected('laptop')

    h.updates.setTarget('dev', target({ version: '0.4.4' }))

    expect(h.reconciler.convergedBy(h.row('laptop'))).toBeUndefined()
  })
})
