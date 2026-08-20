/**
 * A QUEUE THIS DRIVER LOSES SAYS SO (POD-2297).
 *
 * The codex file of the same name states the shape; this is the same three
 * properties against opencode's own plumbing, because the two drivers share a
 * design and not a line of code. What makes this family worth its own file is
 * the vehicle: opencode parks turns behind a HUMAN TAKE-OVER LEASE, which is the
 * queue a real Podium session actually fills (a steward's nudge arriving while
 * somebody is driving the TUI). Every one of those sends answered `queued`, and
 * POD-2291 made that receipt the ledger's last word.
 */

import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../index.js'
import type { OnQueueAbandoned } from '../../queue-abandonment.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const spec = (): SessionSpec => ({
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/abandonment-test',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

type Report = { turnIds: (string | undefined)[]; reason: string }

/** Collect the driver's reports in order, and the port that feeds them. */
function recorder(): { reports: Report[]; onQueueAbandoned: OnQueueAbandoned } {
  const reports: Report[] = []
  return {
    reports,
    onQueueAbandoned: ({ turns, reason }) => {
      reports.push({ turnIds: turns.map((turn) => turn.input.id), reason })
    },
  }
}

describe('a queue this driver loses says so — POD-2297', () => {
  it('reports the whole parked queue when the session is stopped under it', async () => {
    const { reports, onQueueAbandoned } = recorder()
    const runtime = createOpencodeRuntime(makeOpencodeTestHost({ onQueueAbandoned }))
    try {
      const handle = await runtime.driver.create(spec())
      // A human is driving. Two nudges park behind them and are TOLD they are
      // parked — which is the receipt that has to stop being true out loud.
      await handle.lease.acquire('operator', 'human-controller')
      const first = await handle.send(
        { id: 'nudge-1', text: 'when you are done' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      const second = await handle.send(
        { id: 'nudge-2', text: 'and this' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(first.outcome).toBe('queued')
      expect(second.outcome).toBe('queued')

      await handle.stop()

      // ONE report, in queue order: the consumer dedupes by turn id and corrects
      // both receipts from a single durable frame.
      expect(reports).toEqual([{ turnIds: ['nudge-1', 'nudge-2'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })

  it('reports the turn whose send failed, rather than swallowing it', async () => {
    /**
     * THE BUG, HELD STILL. `drainQueue`'s handler was `catch { return }`: the
     * turn had already been `shift()`ed off the queue, so the `return` was the
     * whole of what happened to it. No event, no log, no row — it stopped
     * existing, and the only symptom was an answer that never came.
     */
    const { reports, onQueueAbandoned } = recorder()
    const host = makeOpencodeTestHost({ onQueueAbandoned })
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      const parked = await handle.send(
        { id: 'nudge-lost', text: 'land after the takeover' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(parked.outcome).toBe('queued')

      // The human finishes, the drain runs, and the server answers 500.
      host.serverFor(handle.binding.sessionId)?.failNextPrompt()
      await handle.lease.release('operator')

      await expect
        .poll(() => reports, { timeout: 5000 })
        .toEqual([{ turnIds: ['nudge-lost'], reason: 'delivery-failed' }])
      // The turn never opened, so no epoch moved and no turn event claimed one
      // did: a consumer told a turn FAILED believes a turn RAN.
      expect((await handle.snapshot()).turnEpoch).toBe(0)
    } finally {
      runtime.dispose()
    }
  })

  it('says nothing when there is nothing to say', async () => {
    // An empty queue at teardown is not an abandonment. A report naming no turns
    // would put a frame on the daemon's durable outbox for every session that
    // ever ends.
    const { reports, onQueueAbandoned } = recorder()
    const runtime = createOpencodeRuntime(makeOpencodeTestHost({ onQueueAbandoned }))
    try {
      const handle = await runtime.driver.create(spec())
      await handle.stop()
      expect(reports).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('reports a parked turn once — the queue does not keep its own copy', async () => {
    /**
     * THE REPORT IS THE POINT OF NO RETURN (`TerminalInjectionPorts.onDrainAbandoned`).
     * A queue that retained its turns after reporting them could deliver, on a
     * later drain, words the ledger has already recorded as never delivered —
     * the silent loss again, with a dead-letter row on top of it.
     */
    const { reports, onQueueAbandoned } = recorder()
    const runtime = createOpencodeRuntime(makeOpencodeTestHost({ onQueueAbandoned }))
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send({ id: 'once', text: 'once' }, { origin: 'steward', delivery: 'when-ready' })

      await handle.stop()
      runtime.dispose()

      expect(reports).toEqual([{ turnIds: ['once'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })
})

describe('a session adopted OVER a live one takes its queue with it — POD-2297 review, 1', () => {
  it('reports the displaced queue instead of overwriting it into the garbage collector', async () => {
    /**
     * THE HOLE THE FIRST ROUND LEFT OPEN, and it is not a corner: the daemon's
     * reattach runs `adoptServerDriverSession` BEFORE any live-session check,
     * and a server reconnect can re-send a hundred reattaches at once. So a
     * browser refresh was enough to lose nudges parked behind a take-over lease.
     *
     * `adopt()` never sets `disposed`, so it never reached `endSession` — it
     * built a fresh session object and `sessions.set` overwrote the live one,
     * whose queue was then collected in silence. Measured by the reviewer as
     * NEITHER reported NOR delivered, which is both halves of the promise.
     */
    const { reports, onQueueAbandoned } = recorder()
    const host = makeOpencodeTestHost({ onQueueAbandoned, adoptsLiveEndpoint: true })
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      const parked = await handle.send(
        { id: 'nudge-adopted-away', text: 'land after the takeover' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(parked.outcome).toBe('queued')

      // The reattach the daemon performs on a reconnect, for a session it
      // already holds.
      const adopted = await runtime.driver.adopt(handle.binding)
      expect(adopted.binding.sessionId).toBe(handle.binding.sessionId)

      expect(reports).toEqual([{ turnIds: ['nudge-adopted-away'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })

  it('does not re-report the displaced turn when the adopted session is later stopped', async () => {
    // The displaced object is ended ONCE. A second report would dead-letter a
    // turn the server has already corrected, and the guarded write would make
    // that a silent no-op rather than a visible bug — so it is pinned here.
    const { reports, onQueueAbandoned } = recorder()
    const host = makeOpencodeTestHost({ onQueueAbandoned, adoptsLiveEndpoint: true })
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send(
        { id: 'once-only', text: 'x' },
        { origin: 'steward', delivery: 'when-ready' },
      )

      const adopted = await runtime.driver.adopt(handle.binding)
      await adopted.stop()

      expect(reports).toEqual([{ turnIds: ['once-only'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  })

  it('says nothing when the session it displaces had an empty queue', async () => {
    // The common reattach. A report here would dead-letter nothing and put a
    // durable frame on the outbox for every reconnect in the fleet.
    const { reports, onQueueAbandoned } = recorder()
    const host = makeOpencodeTestHost({ onQueueAbandoned, adoptsLiveEndpoint: true })
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      await runtime.driver.adopt(handle.binding)
      expect(reports).toEqual([])
    } finally {
      runtime.dispose()
    }
  })
})

describe('a dead server stops promising delivery — POD-2297 review, 3', () => {
  it('refuses `not_running` once the queue has been declared dead', async () => {
    /**
     * After a corroborated death `consume()` has returned for good: nothing will
     * drain this session again, and nothing will abandon it again either. `send`
     * gated on `disposed` alone, which the death path deliberately does not set,
     * so every later turn was still answered `queued` — a promise from a queue
     * the driver had already reported abandoned, with nothing left running that
     * could ever break it aloud.
     */
    const { reports, onQueueAbandoned } = recorder()
    const host = makeOpencodeTestHost({ onQueueAbandoned })
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send(
        { id: 'parked-at-death', text: 'parked' },
        { origin: 'steward', delivery: 'when-ready' },
      )

      const server = host.serverFor(handle.binding.sessionId)
      if (!server) throw new Error('no fake server')
      server.alive = false
      await server.close()
      server.dropStreams()

      // The parked turn is reported once, by the death path itself.
      await expect
        .poll(() => reports, { timeout: 20_000 })
        .toEqual([{ turnIds: ['parked-at-death'], reason: 'teardown' }])

      // …and the next turn is REFUSED rather than queued into the void.
      const after = await handle.send(
        { id: 'after-death', text: 'after' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(after.outcome).toBe('refused')
      if (after.outcome !== 'refused') return
      expect(after.refusal.reason).toBe('not_running')
      // A refusal is not an abandonment: nothing was ever accepted, so there is
      // no receipt to correct and no second report.
      expect(reports).toEqual([{ turnIds: ['parked-at-death'], reason: 'teardown' }])
    } finally {
      runtime.dispose()
    }
  }, 30_000)
})
