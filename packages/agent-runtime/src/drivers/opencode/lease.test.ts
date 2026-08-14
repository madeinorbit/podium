/**
 * THE CONTROL LEASE, AND THE TWO VERBS THAT MUST AGREE ABOUT IT (POD-2059's
 * finding on POD-2023).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE AND NOT A CONFORMANCE PROPERTY
 * ---------------------------------------------------------------------------
 *
 * It should be a conformance property — the invariant is spec §5's and belongs
 * to every family, and the terminal driver already satisfies it. The corpus is
 * POD-2085's to edit and it has landed; adding a property there from here would
 * be exactly the collision the epic's ownership split exists to prevent. So the
 * driver-level pin lives here, and POD-2085 has been told what the shared
 * property would look like.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, BECAUSE THE SHAPE OF IT IS THE LESSON
 * ---------------------------------------------------------------------------
 *
 * `lease.acquire()` refused a second holder with `lease_held`. `attach({mode:
 * 'takeover'})` — which the contract defines as *taking the control lease* —
 * assigned it unconditionally. So the session had two doors to one lease and
 * only one of them was locked: two attachers in take-over mode both believed
 * they held it, and the second silently displaced the first.
 *
 * That is worse than neither door being locked. A caller that reads
 * `lease_held` from `acquire()` and branches on it is entitled to believe the
 * exclusion is real; a second mechanism handing the same lease out for free
 * makes the refusal a lie rather than a gap.
 */

import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle, SessionSpec } from '../../index.js'
import { createOpencodeRuntime, type OpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const spec = (): SessionSpec => ({
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/lease-test',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

async function session(): Promise<{ handle: AgentSessionHandle; runtime: OpencodeRuntime }> {
  const runtime = createOpencodeRuntime(makeOpencodeTestHost())
  const handle = await runtime.driver.create(spec())
  return { handle, runtime }
}

describe('attach(takeover) and lease.acquire agree about who holds the lease', () => {
  it('REFUSES a takeover while somebody else holds the lease', async () => {
    const { handle, runtime } = await session()
    try {
      expect(await handle.lease.acquire('operator', 'human-controller')).toMatchObject({
        holder: 'operator',
      })
      // THE REGRESSION. This used to succeed and silently displace `operator`.
      const endpoint = await handle.attach({ mode: 'takeover', holder: 'someone-else' })
      expect(endpoint).toMatchObject({ reason: 'lease_held' })
      // …and the first holder still has it, which is the fact the refusal is
      // about. A refusal that let go of the lease anyway would be theatre.
      expect(await handle.lease.state()).toMatchObject({ holder: 'operator' })
    } finally {
      runtime.dispose()
    }
  })

  it('lets the SAME holder re-attach, because that is not a second controller', async () => {
    const { handle, runtime } = await session()
    try {
      await handle.lease.acquire('operator', 'human-controller')
      const endpoint = await handle.attach({ mode: 'takeover', holder: 'operator' })
      // Re-attaching after a disconnect is the common case and must not be
      // refused by a lease the caller already holds.
      expect('kind' in endpoint).toBe(true)
    } finally {
      runtime.dispose()
    }
  })

  it('never lets a PEEK touch the lease — spectators are unlimited (spec §5)', async () => {
    const { handle, runtime } = await session()
    try {
      await handle.lease.acquire('operator', 'human-controller')
      const endpoint = await handle.attach({ mode: 'peek', holder: 'a-watcher' })
      expect('kind' in endpoint).toBe(true)
      // The watcher is watching, not controlling. If a peek took the lease, a
      // second viewer would evict whoever was actually driving.
      expect(await handle.lease.state()).toMatchObject({ holder: 'operator' })
    } finally {
      runtime.dispose()
    }
  })

  it('TAKES the lease when nobody holds it, so takeover still means takeover', async () => {
    const { handle, runtime } = await session()
    try {
      expect(await handle.lease.state()).toBeNull()
      const endpoint = await handle.attach({ mode: 'takeover', holder: 'operator' })
      expect('kind' in endpoint).toBe(true)
      expect(await handle.lease.state()).toMatchObject({
        holder: 'operator',
        kind: 'human-controller',
      })
      // …and the exclusion it just established is real: a send on somebody
      // else's behalf must not now interleave with the human at the terminal.
      const receipt = await handle.send(
        { text: 'nudge' },
        { origin: 'steward', delivery: 'when-ready' },
      )
      expect(receipt.outcome).not.toBe('accepted')
    } finally {
      runtime.dispose()
    }
  })

  it('does not start a client terminal for a refused takeover', async () => {
    /**
     * THE SECOND HALF OF THE BUG. The old code spawned the client and only then
     * assigned the lease, so a refusal would have left an orphaned TUI attached
     * to a session it was just refused control of. The check now runs first.
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
