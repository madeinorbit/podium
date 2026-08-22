import { asMachineId } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { UPDATE_STEP_DEADLINES, UPDATE_STEP_MACHINES } from './operation'
import {
  decideReconciliation,
  MAX_RECONCILE_ATTEMPTS,
  RECONCILE_GRANT_DEADLINE_MS,
  type ReconcileFacts,
  type ReconcileRefusal,
  UpdateReconciler,
} from './reconciler'
import { GRANT_TIMED_OUT_DETAIL, UpdatesService } from './service'
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
  return target({ artifacts: { headless: { delivery: 'feed', platforms: {} } } } as never)
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

const SPACING_MS = 5_000
/** Short enough to keep the arithmetic in these tests obvious, and only ever
 *  compared against {@link SPACING_MS} — the production number is derived and
 *  asserted separately, below. */
const GRANT_DEADLINE_MS = 60_000

/**
 * A fake clock that RUNS NOTHING until time is moved. "What happens next" is
 * always an explicit `advance()` in the test rather than a race with the event
 * loop.
 *
 * IT IS A CLOCK, not a queue of callbacks, which it did not have to be before
 * POD-2185 gave the reconciler a second timer. Spacing (seconds) and the grant
 * deadline (minutes) answer different questions — "consider the next machine"
 * and "give up on this one" — and draining both together would make every
 * existing spacing test also expire the grant it was about to check on. Holding
 * a real `now` is also the only way to state the case a stale timer breaks: two
 * grants to one machine, armed at different moments, where the FIRST deadline
 * falls due while the second grant is healthy.
 */
function fakeClock() {
  let now = 0
  let seq = 0
  const pending: Array<{ fn: () => void; dueAt: number; seq: number }> = []
  return {
    schedule: (fn: () => void, ms: number) => {
      seq += 1
      pending.push({ fn, dueAt: now + ms, seq })
    },
    /**
     * Move time forward by `ms`, running everything that falls due on the way in
     * due order — including timers armed by the callbacks themselves, which is
     * how the reconciler's re-arming spacing loop behaves in production.
     */
    advance(ms: number = SPACING_MS): number {
      const until = now + ms
      let ran = 0
      for (;;) {
        let next = -1
        for (let index = 0; index < pending.length; index += 1) {
          const timer = pending[index]
          const best = next === -1 ? undefined : pending[next]
          if (!timer || timer.dueAt > until) continue
          if (
            !best ||
            timer.dueAt < best.dueAt ||
            (timer.dueAt === best.dueAt && timer.seq < best.seq)
          )
            next = index
        }
        if (next === -1) break
        const timer = pending.splice(next, 1)[0]
        if (!timer) break
        now = timer.dueAt
        timer.fn()
        ran += 1
        // A runaway re-arm is a bug in the code under test, not a reason to hang
        // the lane; fail loudly instead.
        if (ran > 1_000) throw new Error('fake clock ran away: a timer keeps re-arming at zero')
      }
      now = until
      return ran
    },
    /** Timers due within the next spacing window, unless asked for a wider one. */
    armed: (withinMs: number = SPACING_MS): number =>
      pending.filter((timer) => timer.dueAt <= now + withinMs).length,
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
    spacingMs: SPACING_MS,
    grantDeadlineMs: GRANT_DEADLINE_MS,
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
      name: 'a machine that cannot take this delivery is not handed it anyway',
      over: {
        target: packedTarget(),
        machine: machine({ id: 'src', deliveryCaps: ['podium.shipping-train'] }),
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
    h.clock.advance()
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
    h.clock.advance()
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
    h.clock.advance()

    h.reconciler.onMachineConnected('laptop')
    h.reconciler.onMachineConnected('laptop')
    h.clock.advance()

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
      clock.advance()
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

/**
 * THE LID THAT CLOSED AGAIN (POD-2185).
 *
 * The suite this joins had twelve cases and none of them left a grant
 * outstanding — every one drives its machine to the target between grants, so
 * the state the reconciler spends its whole life in when a laptop sleeps was
 * unreachable from the tests that own this file. These four reach it.
 *
 * The scenario is one machine, once: it wakes at 09:02, takes a grant, and says
 * nothing ever again. No `updateStatus` arrives, so the service keeps its row
 * `downloading` (there is no ageing inside `fleet()` any more — POD-2101), and
 * before this fix the only thing that could have ended it was an operation
 * terminating, which is a thing that by definition was not happening.
 */
describe('UpdateReconciler: a grant that goes silent', () => {
  /** Wake `id`, take the grant, and stop talking — the shared preamble. */
  function granted(ids: string[] = ['laptop']) {
    const h = harness(ids.map((id) => machine({ id })))
    h.updates.setTarget('dev', target())
    for (const id of ids) h.reconciler.onMachineConnected(id)
    const first = ids[0] ?? ''
    h.updates.onStatus(asMachineId(first), {
      type: 'updateStatus',
      state: 'downloading',
      version: '0.4.1',
      grantId: 'g1',
    })
    return h
  }

  /**
   * The wedge itself, stated as the two things it costs: the queue behind the
   * sleeper, and the channel's target refresh.
   *
   * `operationActive` is the second one's mechanism — the scheduled refresh
   * asks it before re-resolving, so a machine stuck IN_FLIGHT forever is a
   * channel that never checks for a new version again (§9.2's cadence). It is
   * asserted here rather than in `service.test.ts` because the only thing that
   * can leave a machine in that state indefinitely is this file.
   */
  it('gives up on it, so the queue behind it moves and the channel can refresh again', () => {
    const h = granted(['laptop', 'vps'])

    // BEFORE the deadline: this is the correct behaviour, not the bug. One at a
    // time is the whole design, and `vps` waiting is `vps` being spaced.
    expect(h.granted()).toEqual(['laptop'])
    h.clock.advance()
    expect(h.granted()).toEqual(['laptop'])
    expect(h.reconciler.pending()).toEqual(['vps'])
    expect(h.updates.operationActive('dev')).toBe(true)

    h.clock.advance(GRANT_DEADLINE_MS)

    expect(h.granted()).toEqual(['laptop', 'vps'])
    expect(h.row('laptop').state).toBe('stuck')
    expect(h.row('laptop').detail).toBe(GRANT_TIMED_OUT_DETAIL)
    // `vps` is now the outstanding one, so the channel is legitimately busy;
    // what matters is that `laptop` alone no longer makes it so, forever.
    h.updates.onStatus(asMachineId('vps'), {
      type: 'updateStatus',
      state: 'current',
      version: TARGET_VERSION,
      grantId: 'g2',
    })
    h.live[1] = machine({ id: 'vps', version: TARGET_VERSION })
    // The directory changes when the daemon handshake lands; the reconnect is
    // the event that makes the service project that raw proof and retire the
    // pending grant. A current status alone is deliberately insufficient.
    h.reconciler.onMachineConnected('vps')
    expect(h.updates.operationActive('dev')).toBe(false)
  })

  /**
   * Expiry writes a TERMINAL state, and the decision table already knows what to
   * do with one. Without this the fix would trade a wedge for a hot loop: the
   * same laptop reconnecting every thirty seconds would be granted every time,
   * because `authorizeMachine` clears a terminal state as the human retry path.
   */
  it('leaves the machine alone afterwards, rather than re-granting on every reconnect', () => {
    const h = granted()
    h.clock.advance(GRANT_DEADLINE_MS)
    expect(h.row('laptop').state).toBe('stuck')

    h.reconciler.onMachineConnected('laptop')
    h.reconciler.onMachineConnected('laptop')
    h.clock.advance(GRANT_DEADLINE_MS)

    expect(h.granted()).toEqual(['laptop'])
  })

  /**
   * A MACHINE THAT ANSWERED KEEPS ITS OWN ANSWER.
   *
   * The timer is armed when the grant goes out and is never disarmed, so it
   * arrives after every outcome, not just after silence — and a machine that
   * said `rejected: dirty working tree` an hour ago is still `rejected` when it
   * lands. Overwriting that with a generic timeout would replace the sentence
   * the operator needs with one that is not even true. This is why expiry goes
   * through `abandonWait`, which acts only on a machine still IN FLIGHT, rather
   * than writing `stuck` on its own authority.
   */
  it('does not overwrite the verdict of a machine that already answered', () => {
    const h = granted()
    h.updates.onStatus(asMachineId('laptop'), {
      type: 'updateStatus',
      state: 'rejected',
      version: '0.4.1',
      grantId: 'g1',
      detail: 'dirty working tree',
    })

    h.clock.advance(GRANT_DEADLINE_MS)

    expect(h.row('laptop').state).toBe('rejected')
    expect(h.row('laptop').detail).toBe('dirty working tree')
    expect(h.granted()).toEqual(['laptop'])
  })

  /**
   * THE STALE TIMER. A machine that converges and then falls behind a NEW target
   * gets a second grant, and the first grant's deadline is still pending. It
   * must not abandon the second one — which is what an id comparison alone
   * would do, and why the reconciler counts grants.
   */
  it('does not let an old grant deadline abandon the next grant to the same machine', () => {
    const h = granted()
    h.updates.onStatus(asMachineId('laptop'), {
      type: 'updateStatus',
      state: 'current',
      version: TARGET_VERSION,
      grantId: 'g1',
    })
    h.live[0] = machine({ id: 'laptop', version: TARGET_VERSION })
    // Time passes between the two grants — which is what makes their deadlines
    // distinguishable, and what makes this the case a bare id check gets wrong.
    h.clock.advance()

    h.updates.setTarget('dev', target({ version: '0.4.4' }))
    h.reconciler.onMachineConnected('laptop')
    expect(h.granted()).toEqual(['laptop', 'laptop'])
    h.updates.onStatus(asMachineId('laptop'), {
      type: 'updateStatus',
      state: 'downloading',
      version: TARGET_VERSION,
      grantId: 'g2',
    })

    // Past the FIRST grant's deadline, short of the second's.
    h.clock.advance(GRANT_DEADLINE_MS - SPACING_MS + 1_000)

    expect(h.row('laptop').state).toBe('downloading')
  })

  /**
   * The number, not the mechanism: this is the same quantity the operation's
   * `machines` step is judged on, because it bounds the same act. Asserted so
   * that moving one of them has to move the other deliberately.
   */
  it('waits exactly as long as the operation would for the same machine', () => {
    expect(RECONCILE_GRANT_DEADLINE_MS).toBe(UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]?.silenceMs)
  })
})
