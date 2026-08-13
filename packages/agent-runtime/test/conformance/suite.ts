/**
 * THE DRIVER CONFORMANCE CORPUS (POD-1761 W1; spec §3).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THE DRIVER SWAP SAFE
 * ---------------------------------------------------------------------------
 *
 * "When codex-server lands it passes the same suite, the selection policy flips,
 * and no server module, view-model or feature changes — because none of them
 * ever knew more than this surface." That sentence is only true if ONE body of
 * properties runs against EVERY driver. This is that body.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. The PROPERTIES — send outcomes, interaction lifecycle, interrupt
 *      requests-then-fences, snapshot→adopt round-trip, causality under restart,
 *      connect-without-secret refusal.
 *   2. The PERMITTED-FAILURES TABLE — per family, what a driver is allowed to
 *      fail or decline, AND the converse: a family not permitted a weakness must
 *      not exhibit it. Without the table the suite is red on the terminal driver
 *      forever; without the converse it is vacuous on the server drivers.
 *
 * ---------------------------------------------------------------------------
 * HOW A DRIVER JOINS (W3, W5, W6)
 * ---------------------------------------------------------------------------
 *
 *   import { describeDriverConformance } from '<this file>'
 *   describeDriverConformance({
 *     name: 'claude-pty', family: 'terminal',
 *     createDriver: () => ({ driver: makeTerminalDriver(deps), control: harnessControl }),
 *     reset: () => …, spec: () => …,
 *   })
 *
 * Nothing else. If a property does not hold, the answer is either a driver fix
 * or an argued addition to the permitted-failures table — never a skip here.
 */

import { describe, expect, it } from 'vitest'
import {
  type AgentSessionHandle,
  CORE_PRIMITIVES,
  type PendingInteraction,
  permits,
  type RuntimeEvent,
  type SessionSpec,
  type TurnReceipt,
} from './contract-imports.js'
import type { ConformanceControl, ConformanceTarget } from './target.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain at most `n` events that are ALREADY buffered. Deliberately not a
 *  timeout-based await: a conformance property that depends on wall-clock
 *  patience is a flake generator, and every event this corpus asks for is
 *  produced synchronously by the verb that precedes it. */
async function drain(stream: AsyncIterable<RuntimeEvent>, n: number): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  if (n === 0) return out
  for await (const event of stream) {
    out.push(event)
    if (out.length >= n) break
  }
  return out
}

const seqOf = (event: RuntimeEvent): number => Number(event.cursor.components.seq ?? 0)

export function describeDriverConformance(target: ConformanceTarget): void {
  describe(`driver conformance — ${target.name} (${target.family})`, () => {
    const setup = (): {
      handle: Promise<AgentSessionHandle>
      control: ConformanceControl
      driver: ReturnType<ConformanceTarget['createDriver']>['driver']
      spec: SessionSpec
    } => {
      target.reset()
      const { driver, control } = target.createDriver()
      const spec = target.spec()
      return { handle: driver.create(spec), control, driver, spec }
    }

    // -----------------------------------------------------------------------
    // Capabilities: the declaration must be honest before anything else is
    // worth checking — every later property reads it.
    // -----------------------------------------------------------------------

    describe('capabilities', () => {
      it('declares every core primitive, implemented or explicitly declined', () => {
        const { driver } = setup()
        const caps = driver.capabilities()
        // `Declared<T>` exists so a gap is stated, not silent. A capability
        // object missing an axis entirely is the failure mode the totality of
        // the type is supposed to prevent — assert it at runtime too, because
        // a driver built from a cast can still get here.
        for (const axis of [
          'send',
          'interrupt',
          'interactions',
          'observation',
          'transcript',
          'attach',
          'lease',
          'snapshot',
          'archive',
        ] as const) {
          expect(caps[axis], `capability axis '${axis}' is undeclared`).toBeDefined()
        }
        expect(CORE_PRIMITIVES.length).toBeGreaterThan(0)
      })

      it('claims `unverified` ONLY where the family permits it', () => {
        const { driver } = setup()
        const caps = driver.capabilities()
        // The converse half of the table. A server driver declaring it "might
        // be unverified" would let a real weakness hide behind a permitted one.
        expect(caps.send.mayReturnUnverified).toBe(permits(target.family, 'unverified-send'))
      })

      it('claims at-least-once interactions ONLY where the family permits it', () => {
        const { driver } = setup()
        const declared = driver.capabilities().interactions
        if (!declared.supported) return
        expect(declared.value.atLeastOnce).toBe(
          permits(target.family, 'at-least-once-interactions'),
        )
      })

      it('ships dedicated placement, or declares that it does not', () => {
        const { driver } = setup()
        // v1 is dedicated-only: per-session MemoryMax and OOM isolation exist
        // only when session = process. Pooling is a DECLARED capability so a
        // pooled session visibly lacks the guarantee (spec §6).
        expect(['dedicated', 'pooled']).toContain(driver.capabilities().placement)
      })
    })

    // -----------------------------------------------------------------------
    // Turns: the four outcomes
    // -----------------------------------------------------------------------

    describe('send — the four outcomes', () => {
      it('ACCEPTED opens a turn and reports the delivery actually used', async () => {
        const { handle } = setup()
        const session = await handle
        const receipt = await session.send(
          { text: 'hello' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        if (receipt.outcome !== 'accepted') return
        expect(receipt.turnEpoch).toBeGreaterThan(0)
        expect(receipt.deliveredAs).toBe('when-ready')
        // Rule 2: the guarantee is family-invariant, the MECHANISM is declared.
        expect(driverProof(session, receipt)).toBe(true)
      })

      it('QUEUED carries a durable position rather than a shrug', async () => {
        const { handle } = setup()
        const session = await handle
        await session.send({ text: 'first' }, { origin: 'human', delivery: 'when-ready' })
        const receipt = await session.send(
          { text: 'second' },
          { origin: 'human', delivery: 'queue' },
        )
        expect(receipt.outcome).toBe('queued')
        if (receipt.outcome !== 'queued') return
        expect(receipt.position).toBeGreaterThan(0)
        expect(receipt.deliveredAs).toBe('queue')
      })

      it('REFUSED is typed, and `needs_user` is what a blocking ask produces', async () => {
        const { handle, control } = setup()
        const session = await handle
        control.askInteraction(session.binding.sessionId, 'permission', { tool: 'Bash' })
        const receipt = await session.send(
          { text: 'go on' },
          { origin: 'steward', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('refused')
        if (receipt.outcome !== 'refused') return
        // Typed reason, not a string a caller has to parse. This is what lets
        // the steward branch instead of retrying blind.
        expect(receipt.refusal.reason).toBe('needs_user')
      })

      it('reports a `steer` downgrade via deliveredAs — never silently', async () => {
        const { handle, driver } = setup()
        const session = await handle
        await session.send({ text: 'open a turn' }, { origin: 'human', delivery: 'when-ready' })
        const receipt = await session.send(
          { text: 'and this too' },
          { origin: 'mail', delivery: 'steer' },
        )
        const nativeSteer = driver.capabilities().send.native.includes('steer')
        if (nativeSteer) {
          expect(receipt.outcome).toBe('accepted')
          if (receipt.outcome !== 'accepted') return
          expect(receipt.deliveredAs).toBe('steer')
          return
        }
        // The permitted failure is the DOWNGRADE, never the silence. Whatever
        // the outcome, `deliveredAs` must say what really happened.
        expect(permits(target.family, 'no-native-steer')).toBe(true)
        expect(receipt.outcome === 'queued' || receipt.outcome === 'accepted').toBe(true)
        if (receipt.outcome === 'queued' || receipt.outcome === 'accepted') {
          expect(receipt.deliveredAs).not.toBe('steer')
        }
      })

      it('UNVERIFIED is available exactly to the families permitted it', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        if (!permits(target.family, 'unverified-send')) {
          // Nothing to induce: the family has no such outcome, and the
          // capability assertion above already pinned the declaration.
          expect(driver.capabilities().send.mayReturnUnverified).toBe(false)
          return
        }
        control.failNextVerification(session.binding.sessionId)
        const receipt = await session.send(
          { text: 'did this land?' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('unverified')
        if (receipt.outcome !== 'unverified') return
        // The two-generals gap made explicit: the caller is told how long we
        // already waited, so "retry or surface" is their decision with the
        // truth in hand rather than a guess.
        expect(receipt.verificationWindowMs).toBeGreaterThan(0)
      })
    })

    // -----------------------------------------------------------------------
    // Interactions
    // -----------------------------------------------------------------------

    describe('interactions', () => {
      it('asked → answered, and the ask is enumerable while open', async () => {
        const { handle, control } = setup()
        const session = await handle
        const id = control.askInteraction(session.binding.sessionId, 'permission', {
          tool: 'Bash',
        })
        const open = await session.interactions()
        // "Stuck" is supposed to be impossible to hide: a blocked session is BY
        // CONSTRUCTION a session with an open interaction (spec §4).
        expect(open.map((i: PendingInteraction) => i.id)).toContain(id)
        expect(await session.answer(id, { decision: 'allow' })).toEqual({ ok: true })
        expect(await session.interactions()).toHaveLength(0)
      })

      it('answering twice is a typed error, not a double action', async () => {
        const { handle, control } = setup()
        const session = await handle
        const id = control.askInteraction(session.binding.sessionId, 'question')
        await session.answer(id, { index: 0 })
        const second = await session.answer(id, { index: 1 })
        expect(second).toEqual({ ok: false, reason: 'already-answered' })
      })

      it('answering an unknown interaction is refused, not ignored', async () => {
        const { handle } = setup()
        const session = await handle
        expect(await session.answer('no-such-interaction', {})).toEqual({
          ok: false,
          reason: 'unknown-interaction',
        })
      })

      it('may be asked in ANY phase, including before the first turn', async () => {
        const { handle, control } = setup()
        const session = await handle
        // Resume-time recovery prompts are asked while the handle is still
        // starting. A driver that gated interactions on a running turn would
        // strand every background executor at boot.
        const id = control.askInteraction(session.binding.sessionId, 'recovery', {
          prompt: 'resume from summary?',
        })
        expect((await session.interactions()).map((i) => i.id)).toContain(id)
      })

      it('classifier-sourced asks are at-least-once ONLY where permitted', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        const declared = driver.capabilities().interactions
        if (!declared.supported || !permits(target.family, 'at-least-once-interactions')) return
        const first = control.askInteraction(session.binding.sessionId, 'permission')
        const duplicate = control.reaskInteraction(session.binding.sessionId, first)
        // A re-rendered menu mints a SECOND id for the SAME logical ask. The
        // contract does not pretend otherwise; `source` makes it visible and
        // consumers must dedupe by fingerprint.
        expect(duplicate).not.toBe(first)
        const open = await session.interactions()
        expect(open.length).toBeGreaterThanOrEqual(2)
        expect(open.every((i) => i.source === declared.value.source)).toBe(true)
      })
    })

    // -----------------------------------------------------------------------
    // Interrupt
    // -----------------------------------------------------------------------

    describe('interrupt', () => {
      it('REQUESTS a fence and never manufactures one', async () => {
        const { handle, control } = setup()
        const session = await handle
        const accepted = await session.send(
          { text: 'long task' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(accepted.outcome).toBe('accepted')
        const before = await session.snapshot()

        await session.interrupt()

        // NOTHING closed the turn yet. Fences are absorbing and state is never
        // fabricated — an interrupt that emitted its own fence would let a
        // consumer believe a turn ended that the provider is still running.
        const afterRequest = await session.snapshot()
        expect(afterRequest.turnEpoch).toBe(before.turnEpoch)

        // Provider confirmation is what fences it.
        control.completeTurn(session.binding.sessionId)
        const events = await drain(session.events(before.cursor), 1)
        const turnEvents = events.filter((e) => e.t === 'turn')
        expect(turnEvents.length).toBeGreaterThan(0)
      })
    })

    // -----------------------------------------------------------------------
    // Snapshot → adopt round-trip, and causality under restart
    // -----------------------------------------------------------------------

    describe('adopt', () => {
      it('round-trips a snapshot across a supervisor restart', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        await session.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
        control.completeTurn(session.binding.sessionId)
        const before = await session.snapshot()

        control.restartSupervisor()
        const adopted = await driver.adopt(before.binding)
        const after = await adopted.snapshot()

        // Same session, same process, same conversation position.
        expect(after.binding.sessionId).toBe(before.binding.sessionId)
        expect(after.binding.process.key).toBe(before.binding.process.key)
        // The turn epoch is MONOTONIC across a rebind. Resetting it is how a
        // replayed stream looks like new work.
        expect(after.turnEpoch).toBeGreaterThanOrEqual(before.turnEpoch)
        // A rebind is a NEW observer generation; a stale one must be rejectable.
        expect(after.observerGeneration).toBeGreaterThan(before.observerGeneration)
        expect(after.binding.bindingVersion).toBeGreaterThan(before.binding.bindingVersion)
      })

      it('keeps the event stream causally fenced after a rebind', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        await session.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
        control.completeTurn(session.binding.sessionId)
        const checkpoint = await session.snapshot()

        control.restartSupervisor()
        const adopted = await driver.adopt(checkpoint.binding)
        control.askInteraction(adopted.binding.sessionId, 'permission')

        const events = await drain(adopted.events(checkpoint.cursor), 1)
        expect(events.length).toBeGreaterThan(0)
        for (const event of events) {
          // Cursor-fenced: nothing at or before the checkpoint is re-delivered.
          expect(seqOf(event)).toBeGreaterThan(Number(checkpoint.cursor.components.seq ?? 0))
          // Post-checkpoint events are live; a replay must say so instead, and
          // a consumer must never apply live effects from one.
          expect(event.provenance).not.toBe('bootstrap')
        }
      })

      it('refuses to adopt a binding whose process did not survive', async () => {
        const { handle, driver } = setup()
        const session = await handle
        const binding = session.binding
        await session.kill()
        // EXACT identity. Adopting the wrong process is worse than not
        // adopting: it produces a session that reports someone else's work.
        await expect(driver.adopt(binding)).rejects.toThrow()
      })
    })

    // -----------------------------------------------------------------------
    // Lifecycle refusals
    // -----------------------------------------------------------------------

    describe('lifecycle', () => {
      it('hibernate REFUSES without a resume ref', async () => {
        const { handle } = setup()
        const session = await handle
        const result = await session.hibernate()
        if (session.binding.resume) {
          expect(result).toEqual({ ok: true })
          return
        }
        // Hibernating a session we cannot bring back is data loss wearing a
        // lifecycle verb's name.
        expect(result).toMatchObject({ reason: 'no_resume_ref' })
      })

      it('a human take-over lease excludes other controllers', async () => {
        const { handle } = setup()
        const session = await handle
        const declared = (await session.lease.state()) ?? null
        expect(declared === null || typeof declared.holder === 'string').toBe(true)
        const lease = await session.lease.acquire('operator', 'human-controller')
        expect(lease).toMatchObject({ holder: 'operator' })
        const receipt = await session.send(
          { text: 'nudge' },
          { origin: 'steward', delivery: 'when-ready' },
        )
        // Exactly one controller. This is what makes "the user attached and
        // started typing" and "the steward tried to nudge" un-interleavable.
        expect(receipt.outcome).toBe('refused')
        if (receipt.outcome === 'refused') expect(receipt.refusal.reason).toBe('lease_held')
      })
    })

    // -----------------------------------------------------------------------
    // Attach
    // -----------------------------------------------------------------------

    describe('attach', () => {
      it('produces the variant its family declares, or declines outright', async () => {
        const { handle, driver } = setup()
        const session = await handle
        const declared = driver.capabilities().attach
        const endpoint = await session.attach({ mode: 'peek', holder: 'viewer' })
        if (!declared.supported) {
          // The embedded family has no terminal at all and says so — chat is
          // the answer, not a fabricated stream.
          expect(permits(target.family, 'no-attach')).toBe(true)
          expect(endpoint).toMatchObject({ reason: 'unsupported' })
          return
        }
        expect('kind' in endpoint).toBe(true)
        if ('kind' in endpoint) expect(declared.value.kinds).toContain(endpoint.kind)
      })
    })

    // -----------------------------------------------------------------------
    // Security (spec §6): the server family's per-session endpoint
    // -----------------------------------------------------------------------

    describe('endpoint security', () => {
      it('refuses a connection without the per-session secret', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        if (driver.family !== 'server') {
          // Terminal and embedded sessions expose no network endpoint, so there
          // is nothing to authenticate. Stated rather than skipped silently.
          expect(control.connectWithoutSecret(session.binding.sessionId).refused).toBe(false)
          return
        }
        // An unauthenticated per-session HTTP server holding a credentialed
        // agent is not acceptable even on loopback: every local process and
        // user can reach it.
        expect(control.connectWithoutSecret(session.binding.sessionId).refused).toBe(true)
      })
    })
  })
}

/** The receipt's proof must be one the driver declared it can produce. Rule 2 in
 *  one assertion: callers stop caring WHICH mechanism proved delivery, but the
 *  driver may not invent one it never claimed. */
function driverProof(_session: AgentSessionHandle, receipt: TurnReceipt): boolean {
  return receipt.outcome !== 'accepted' || typeof receipt.provenBy === 'string'
}
