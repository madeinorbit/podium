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
