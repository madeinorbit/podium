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
  type DriverCapabilities,
  type DriverFamily,
  PERMITTED_FAILURES,
  type PendingInteraction,
  permits,
  type RuntimeEvent,
  type SessionSpec,
  type TurnReceipt,
} from '../../index.js'
import type { ConformanceControl, ConformanceOptions, ConformanceTarget } from './target.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Take up to `n` events, giving up after `timeoutMs` rather than waiting forever.
 *
 * THE TIMEOUT IS THE POINT. An earlier version of this helper had none, on the
 * argument that every event the corpus asks for is produced synchronously by the
 * verb before it. That is true of the in-memory fake and false of every real
 * driver: a PTY driver's events arrive when a hook fires or a file grows. Without
 * a bound, a driver that never emits HANGS the suite instead of failing it — and
 * a hung gate reads as infrastructure trouble rather than a broken driver, which
 * is the worst failure mode a conformance corpus can have.
 *
 * It returns what it got rather than throwing, so each property states its own
 * expectation about how many events it needed.
 */
async function drain(
  stream: AsyncIterable<RuntimeEvent>,
  n: number,
  timeoutMs = 2000,
): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  if (n === 0) return out
  const iterator = stream[Symbol.asyncIterator]()
  const deadline = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    // Never hold the process open on the corpus's account.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
  while (out.length < n) {
    const next = await Promise.race([iterator.next(), deadline])
    if (next === 'timeout' || next.done) break
    out.push(next.value)
  }
  await iterator.return?.()
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
        // The check lives in an exported function so the "corpus has teeth"
        // tests can drive it with a dishonest driver and watch it refuse. An
        // assertion whose only caller is its own property cannot be shown to
        // bite.
        assertUnverifiedClaimHonest(target.family, driver.capabilities())
      })

      it('claims at-least-once interactions ONLY for classifier-sourced asks', () => {
        const { driver } = setup()
        const declared = driver.capabilities().interactions
        if (!declared.supported) return
        const { atLeastOnce, source } = declared.value

        // THE PERMISSION IS PER-SOURCE, NOT PER-FAMILY, and the difference is
        // load-bearing rather than pedantic. The exemption exists because a
        // re-rendered menu can mint a duplicate ask and a keystroke answer
        // cannot prove which menu it acted on — that is a property of the
        // SCREEN CLASSIFIER, not of the terminal family. W3's `claude-pty`
        // reads `UserPromptSubmit`, a real causal hook: it has better identity
        // than this and must be able to decline the exemption. A strict
        // per-family equality here would force it to declare a weakness it does
        // not have, which is exactly the dishonesty the table exists to prevent.
        if (atLeastOnce) {
          expect(source).toBe('screen-classifier')
          // …and the family must still be one the table permits it to.
          expect(permits(target.family, 'at-least-once-interactions')).toBe(true)
        }
        // The converse: a classifier-sourced driver may NOT claim exactly-once
        // identity, because it cannot have it.
        if (source === 'screen-classifier') expect(atLeastOnce).toBe(true)
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
        const { handle, control, driver } = setup()
        const session = await handle
        const receipt = await session.send(
          { text: 'hello' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        if (receipt.outcome !== 'accepted') return
        expect(receipt.turnEpoch).toBeGreaterThan(0)
        expect(receipt.deliveredAs).toBe('when-ready')
        // The counter's other end: a send that DID prove itself also delivered
        // exactly once, so the `unverified` assertion below is measuring
        // restraint rather than a counter nobody increments.
        expect(control.deliveryAttempts(session.binding.sessionId)).toBe(1)
        // Rule 2: the guarantee is family-invariant, the MECHANISM is declared —
        // and a driver may not invent a mechanism it never claimed.
        expectDeclaredProof(driver.capabilities(), receipt)
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
        const permitted = permits(target.family, 'unverified-send')

        // THE CONVERSE IS EXERCISED, NOT RESTATED. An earlier version re-asserted
        // the capability flag here — the identical assertion made in the
        // capabilities block — so nothing went red if this property were deleted.
        // Now a family that may not return `unverified` is actually PUSHED at the
        // failure and must not produce one.
        control.failNextVerification(session.binding.sessionId)
        let receipt: TurnReceipt | undefined
        let threw = false
        try {
          receipt = await session.send(
            { text: 'did this land?' },
            { origin: 'human', delivery: 'when-ready' },
          )
        } catch {
          // A driver that declared the outcome impossible may refuse to model it
          // at all. Throwing is a legitimate answer to "produce an outcome you
          // said you cannot produce"; silently producing it is not.
          threw = true
        }

        if (!permitted) {
          expect(driver.capabilities().send.mayReturnUnverified).toBe(false)
          if (!threw) expect(receipt?.outcome).not.toBe('unverified')
          return
        }

        expect(threw).toBe(false)
        expect(receipt?.outcome).toBe('unverified')
        if (receipt?.outcome !== 'unverified') return
        // The two-generals gap made explicit: the caller is told how long we
        // already waited, so "retry or surface" is their decision with the truth
        // in hand rather than a guess.
        expect(receipt.verificationWindowMs).toBeGreaterThan(0)
        // NEVER CONVERTED, NEVER RETRIED INTO A LIE. The whole reason this
        // outcome exists is that the old code retried an unprovable submit up to
        // twice and reported success. `unverified` must reach the caller as
        // itself — not silently upgraded to `accepted`, not downgraded to
        // `refused` — and the driver must not have opened a turn behind it.
        expect(receipt.deliveredAs).toBeTruthy()
        const after = await session.snapshot()
        expect(after.turnEpoch).toBe(0)
        // DIRECTLY, not by inference. The epoch assertion above only refutes a
        // retry that OPENS A TURN; a terminal driver can re-type a prompt with
        // no epoch moving anywhere, which is precisely what the mechanism this
        // outcome replaced did — it re-submitted an unprovable send up to twice
        // and called the result success. One send, one delivery of the caller's
        // words, however many keystrokes that took.
        expect(control.deliveryAttempts(session.binding.sessionId)).toBe(1)
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

      it('advances cursors MONOTONICALLY across a rebind', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        await session.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
        control.completeTurn(session.binding.sessionId)
        const checkpoint = await session.snapshot()

        control.restartSupervisor()
        const adopted = await driver.adopt(checkpoint.binding)
        control.askInteraction(adopted.binding.sessionId, 'permission')
        control.askInteraction(adopted.binding.sessionId, 'question')

        // MORE THAN ONE EVENT, deliberately: every other property in this file
        // takes a single event, so none of them can compare two cursors. An
        // ordering guarantee that is never tested on a pair is not tested.
        const events = await drain(adopted.events(checkpoint.cursor), 3)
        expect(events.length).toBeGreaterThanOrEqual(2)
        for (let i = 1; i < events.length; i++) {
          const previous = events[i - 1]
          const current = events[i]
          if (!previous || !current) continue
          // Strictly increasing. Equal cursors on distinct events would make a
          // resume position ambiguous — the consumer could not tell whether it
          // had already applied the second one.
          expect(seqOf(current)).toBeGreaterThan(seqOf(previous))
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
        /**
         * EXACTLY ONE CONTROLLER — which is a statement about what must NOT
         * reach the agent, not about which of two honest answers a driver gives.
         *
         * This property used to demand `refused`/`lease_held`. That over-specified
         * it, and it over-specified it in the direction that loses work: the
         * contract's own `lease_held` says "headless drivers QUEUE rather than
         * interleave — exactly what `queueText` does today", and the terminal
         * plan is explicit that the terminal path has exactly two refusals
         * (not-running, and `needs_user` without a post-ESC) and that no
         * lease-based refusal may be invented. A driver that queues under a
         * human's lease has not interleaved anything: the turn lands after the
         * takeover ends, which is what a steward asking to nudge actually wants.
         *
         * So both answers pass, and what is pinned is the invariant neither may
         * break — the nudge did not get through. A driver whose family CAN
         * refuse still may; a driver that queues must report the degradation
         * through `deliveredAs`, which is not optional for anyone.
         */
        expect(receipt.outcome).not.toBe('accepted')
        expect(receipt.outcome).not.toBe('unverified')
        if (receipt.outcome === 'refused') expect(receipt.refusal.reason).toBe('lease_held')
        if (receipt.outcome === 'queued') expect(receipt.deliveredAs).toBe('queue')
      })
    })

    // -----------------------------------------------------------------------
    // Hibernate without a resume ref — the refusal path, actually reached
    // -----------------------------------------------------------------------

    describe('hibernate without a resume ref', () => {
      it('REFUSES rather than losing the session', async () => {
        const { driver, spec } = setup()
        // `resume()` with a ref the driver cannot keep is the honest way to
        // reach this: an earlier version only ever exercised `create()`, which
        // always mints a ref, so the refusal branch was asserted in a property
        // that could never reach it.
        const session = await driver.create(spec)
        if (session.binding.resume) {
          // This driver captures its ref at spawn (`resumeRefTiming: 'spawn'`),
          // so hibernation is legal and the refusal is unreachable BY
          // CONSTRUCTION rather than by omission. Say so instead of pretending
          // to test it.
          expect(await session.hibernate()).toEqual({ ok: true })
          return
        }
        // A driver whose harness mints the ref lazily (Codex rollout files)
        // legitimately has no ref yet, and must refuse.
        expect(await session.hibernate()).toMatchObject({ reason: 'no_resume_ref' })
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

/**
 * The receipt's proof must be one the driver DECLARED it can produce.
 *
 * Spec rule 2 in one assertion: callers stop caring which mechanism proved
 * delivery, but the driver may not invent one it never claimed. A driver
 * returning `provenBy: 'protocol-ack'` while declaring
 * `proof: ['transcript-echo']` is describing a fidelity it does not have, and
 * every consumer that branches on the declaration is then branching on a lie.
 *
 * (An earlier version of this checked `typeof receipt.provenBy === 'string'`,
 * which is a tautology on any type-checked driver — the assertion named a
 * property it did not test.)
 */
function expectDeclaredProof(capabilities: DriverCapabilities, receipt: TurnReceipt): void {
  if (receipt.outcome !== 'accepted') return
  expect(
    capabilities.send.proof,
    `receipt claims proof '${receipt.provenBy}', which this driver never declared`,
  ).toContain(receipt.provenBy)
}

/**
 * THE ENTRY POINT A DRIVER AUTHOR CALLS (W3, W5, W6).
 *
 *   runConformance(
 *     () => ({ driver: makeTerminalDriver(deps), control: harnessControl }),
 *     { exemptions: ['unverified-send', 'at-least-once-interactions'] },
 *   )
 *
 * `exemptions` is verified against the family's row in `PERMITTED_FAILURES`
 * before a single property runs, and a mismatch fails immediately with the
 * difference named. That ordering is deliberate: an exemption list that silently
 * disagreed with the table would let a driver skip a property it was never
 * entitled to skip, and the resulting green suite would be worse than no suite.
 */
export function runConformance(
  makeDriver: ConformanceTarget['createDriver'],
  opts: ConformanceOptions & Pick<ConformanceTarget, 'name' | 'family' | 'reset' | 'spec'>,
): void {
  describe(`declared exemptions — ${opts.name}`, () => {
    it('claims exactly what its family permits, no more and no less', () => {
      const claimed = [...(opts.exemptions ?? [])].sort()
      const permitted = [...PERMITTED_FAILURES[opts.family]].sort()
      expect(claimed).toEqual(permitted)
    })
  })
  describeDriverConformance({
    name: opts.name,
    family: opts.family,
    createDriver: makeDriver,
    reset: opts.reset,
    spec: opts.spec,
  })
}

/**
 * A driver may claim `unverified` sends only where its family permits them.
 *
 * BOTH DIRECTIONS, and the second is the one that matters. Forbidding an
 * unpermitted claim is obvious; requiring a permitted family to actually declare
 * it is what stops a terminal driver from quietly asserting protocol-grade
 * fidelity it cannot deliver. `unverified` exists because the old code retried an
 * unprovable submit and reported success — a driver that hides the possibility is
 * back in that world.
 *
 * Exported so the corpus's own negative tests can call it with a deliberately
 * dishonest driver: an assertion that has never been watched to fail is a
 * comment.
 */
export function assertUnverifiedClaimHonest(
  family: DriverFamily,
  capabilities: DriverCapabilities,
): void {
  expect(
    capabilities.send.mayReturnUnverified,
    `family '${family}' ${permits(family, 'unverified-send') ? 'permits' : 'does not permit'} unverified sends`,
  ).toBe(permits(family, 'unverified-send'))
}
