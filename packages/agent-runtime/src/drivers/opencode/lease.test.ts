/**
 * WHAT IS LEFT OF THE DRIVER-LEVEL LEASE PIN, ONCE THE CORPUS OWNS THE
 * INVARIANT (POD-2059's finding on POD-2023; the shared property is POD-2085's).
 *
 * ---------------------------------------------------------------------------
 * THE DUPLICATE IS GONE, AND THIS IS WHAT IT WAS
 * ---------------------------------------------------------------------------
 *
 * This file used to open with four tests pinning the bug POD-2059 found:
 * `lease.acquire()` refused a second holder with `lease_held` while
 * `attach({mode: 'takeover'})` — which the contract defines as *taking the
 * control lease* — assigned it unconditionally, so two attachers both believed
 * they held it and the second silently displaced the first. One door locked,
 * one door open, on the same lease.
 *
 * They lived here rather than in the corpus for one reason, stated plainly at
 * the time: the corpus was POD-2085's to edit, and adding a property there from
 * here would have been the collision the epic's ownership split exists to
 * prevent. That reason has expired. `assertAttachHonoursOneControlLease` in
 * `testing/conformance/suite.ts` now asserts every one of them, for EVERY
 * family rather than this driver alone:
 *
 *   - refuses a takeover while somebody else holds it, and the holder does not
 *     move                                                    (suite, `lease_held`)
 *   - lets the SAME holder re-attach                          (suite)
 *   - never lets a peek touch the lease, even while held      (suite)
 *   - takes the lease when nobody holds it, and a steward's
 *     nudge does not then reach the agent   (suite, 'a human take-over lease
 *                                            excludes other controllers')
 *
 * Keeping a second copy against one driver would mean the shared property could
 * rot on this family without anything going red — which is the failure the
 * corpus exists to end, reproduced in miniature.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REST STAYED, WHICH IS NOT THE SAME QUESTION
 * ---------------------------------------------------------------------------
 *
 * What remains is what the corpus CANNOT see from where it stands. It drives a
 * driver through the contract; it has no way to observe that no client terminal
 * was ever spawned, no way to release a lease and watch a parked turn drain, and
 * no way to make a health probe fail once. Those are facts about this driver's
 * internals and this harness's fake, and a shared property that could reach them
 * would have to grow a control surface for opencode's plumbing — which is the
 * corpus asking every other family to carry this one's shape.
 */

import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../index.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const spec = (): SessionSpec => ({
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/lease-test',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

// The `session()` helper that used to sit here went with the four tests the
// corpus now owns: every test left builds its own runtime, because each one
// needs a host wired for the specific thing it observes.

describe('a refused takeover leaves nothing running behind it', () => {
  it('does not start a client terminal for a refused takeover', async () => {
    /**
     * THE SECOND HALF OF THE BUG, AND THE HALF THE CORPUS CANNOT SEE. The old
     * code spawned the client and only then assigned the lease, so a refusal
     * would have left an orphaned TUI attached to a session it was just refused
     * control of. The check now runs first.
     *
     * The shared property pins the lease side of this — a refused attach is not
     * holding the lease — because every family can observe a lease through the
     * contract. NOBODY can observe a process that should not exist without
     * asking the host, so this one stays at driver level, where the host is.
     */
    const started: string[] = []
    const runtime = createOpencodeRuntime(
      makeOpencodeTestHost({
        onAttachClient: (input) => {
          started.push(input.mode)
        },
      }),
    )
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.attach({ mode: 'takeover', holder: 'someone-else' })
      expect(started).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('reserves the lease before awaiting client startup, so racing holders cannot both win', async () => {
    let finishStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve
    })
    const host = makeOpencodeTestHost()
    host.attachClient = async ({ sessionId }) => {
      await startGate
      return { streamId: `test-attach-${sessionId}`, warmTtlMs: 60_000 }
    }
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      const first = handle.attach({ mode: 'takeover', holder: 'first' })
      await Promise.resolve()
      await expect(handle.attach({ mode: 'takeover', holder: 'second' })).resolves.toMatchObject({
        reason: 'lease_held',
      })
      finishStart?.()
      await expect(first).resolves.toMatchObject({ kind: 'client' })
      await expect(handle.lease.acquire('second', 'human-controller')).resolves.toMatchObject({
        reason: 'lease_held',
      })
    } finally {
      finishStart?.()
      runtime.dispose()
    }
  })
})

describe('releasing the lease drains what was queued behind it', () => {
  it('lands a turn queued under a take-over once the human RELEASES', async () => {
    /**
     * W3's F6 in one property (POD-2059's review). A `queue` that arrives while
     * a human holds the take-over lease is PARKED rather than refused — the
     * contract's own note is that headless drivers queue rather than interleave,
     * and the nudge is supposed to land after the takeover ends.
     *
     * It did not. `drainQueue` only ran from `closeTurn`, so on an IDLE session
     * the parked turn waited for a turn edge that might never come: release the
     * lease with nothing running and the steward's nudge sat there indefinitely.
     * "After the takeover ends" has to mean the release itself.
     */
    const runtime = createOpencodeRuntime(makeOpencodeTestHost())
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')

      const receipt = await handle.send(
        { text: 'land this after the human is done' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      // Parked, not refused, and it says so with a durable position.
      expect(receipt.outcome).toBe('queued')

      await handle.lease.release('operator')

      // The turn reaches opencode without anything else having to happen. The
      // session was IDLE throughout, which is exactly the case the old code
      // could not serve.
      await expect
        .poll(() => runtime.handleFor(handle.binding.sessionId) !== undefined, { timeout: 2000 })
        .toBe(true)
      await expect
        .poll(async () => (await handle.snapshot()).turnEpoch, { timeout: 5000 })
        .toBeGreaterThan(0)
    } finally {
      runtime.dispose()
    }
  })

  it('does not drain for a release by somebody who never held it', async () => {
    // The guard the drain sits behind: a stray release must not become a way to
    // push somebody else's queued turn at the agent.
    const runtime = createOpencodeRuntime(makeOpencodeTestHost())
    try {
      const handle = await runtime.driver.create(spec())
      await handle.lease.acquire('operator', 'human-controller')
      await handle.send({ text: 'parked' }, { origin: 'steward', delivery: 'when-ready' })
      await handle.lease.release('a-stranger')
      expect(await handle.lease.state()).toMatchObject({ holder: 'operator' })
      expect((await handle.snapshot()).turnEpoch).toBe(0)
    } finally {
      runtime.dispose()
    }
  })
})

describe('a slow health probe is not a dead server (POD-2114)', () => {
  it('does NOT declare the process exited when a probe merely fails once', async () => {
    /**
     * THE GHOST SESSION, PINNED. The consume loop used to ask `/global/health`
     * ONCE after an SSE drop and believe the answer. On a loaded box a probe can
     * exceed the client's timeout while the server is perfectly alive — POD-2086
     * measured a session declared `exited` at 342s whose server was still
     * answering 200 twenty minutes later, holding a provider credential, with
     * every later send queued forever against a session that would never drain.
     *
     * The driver's own `errors.ts` says a transport failure is not a session
     * failure. This is that sentence as a test: the SSE stream is really
     * dropped, the first probe really fails, and the server was really there.
     */
    let probes = 0
    const host = makeOpencodeTestHost({
        wrapClient: (client) => ({
          ...client,
          health: async () => {
            probes += 1
            // The first probe answers the way a SLOW one does on a loaded box.
            // Every later probe tells the truth: the server is there.
            return probes > 1 ? client.health() : false
          },
        }),
    })
    const runtime = createOpencodeRuntime(host)
    try {
      const handle = await runtime.driver.create(spec())
      const exits: string[] = []
      void (async () => {
        for await (const event of handle.events('bootstrap')) {
          if (event.t === 'process' && event.ev.ev === 'exited') exits.push('exited')
        }
      })()

      host.serverFor(handle.binding.sessionId)?.dropStreams()

      await expect.poll(() => probes, { timeout: 6000 }).toBeGreaterThan(1)
      // Corroboration happened and said "alive", so no exit was ever claimed.
      expect(exits).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })
})
