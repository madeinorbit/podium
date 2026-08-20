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

import type { ResumeRef } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AgentSessionHandle,
  type AttachmentKind,
  type AttachmentSource,
  CORE_PRIMITIVES,
  type DriverCapabilities,
  type DriverFamily,
  type DriverId,
  NO_NATIVE_STEER_DRIVERS,
  PERMITTED_FAILURES,
  type PendingInteraction,
  permits,
  permitsNoNativeSteer,
  type ResumeRefTiming,
  type RuntimeDriver,
  type RuntimeEvent,
  type SessionSpec,
  streamItemIdOf,
  type TurnReceipt,
} from '../../index.js'
import { defaultAskFor } from '../fake-driver.js'
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
  if (n === 0) return []
  return collectUntil(stream, (_event, taken) => taken >= n, timeoutMs)
}

/**
 * Collect events until one MATCHES, or the deadline passes.
 *
 * WHY THIS EXISTS ALONGSIDE {@link drain} (POD-2023). `drain(stream, 1)` takes
 * the first event and nothing else, which silently made one property depend on
 * the driver emitting NOTHING between the checkpoint and the event under test.
 * That held for the in-memory fake and for the terminal fixture, and it does not
 * hold for any driver whose provider publishes liveness: opencode emits a
 * `session.status: busy` heartbeat several times per turn, so the first event
 * after a checkpoint is a state change and the property failed for a reason that
 * had nothing to do with fences.
 *
 * Waiting for the MATCH rather than for a count states what the property
 * actually means — "an event of this kind arrives after provider confirmation" —
 * and it stays fast, because it stops at the match instead of waiting out a
 * quota that may never fill.
 */
const drainUntil = (
  stream: AsyncIterable<RuntimeEvent>,
  match: (event: RuntimeEvent) => boolean,
  timeoutMs = 2000,
): Promise<RuntimeEvent[]> => collectUntil(stream, (event) => match(event), timeoutMs)

/** A token fragment, narrowed. Written as a guard rather than a filter
 *  predicate so the assertions below can read `.item.itemId` without a cast —
 *  the union arm is what every property in the fine-watch group is about. */
type DeltaEvent = RuntimeEvent & {
  t: 'item'
  item: { kind: 'delta'; itemId: string; textDelta: string }
}
const isDeltaEvent = (event: RuntimeEvent): event is DeltaEvent =>
  event.t === 'item' && event.item.kind === 'delta'

/** Every arm the live-only fine plane carries: a fragment of an item still
 *  being written, and a whole item still being run. Neither may reach a coarse
 *  watcher, and both are retired by the `complete` that shares their stream
 *  identity — so the properties below quantify over both rather than over the
 *  one arm that happened to exist first. */
const isFineOnlyEvent = (event: RuntimeEvent): boolean =>
  event.t === 'item' && event.item.kind !== 'complete'

/** The stream identity a fine-only event claims, whichever arm it is. */
const fineOnlyStreamId = (event: RuntimeEvent): string | undefined => {
  if (event.t !== 'item') return undefined
  if (event.item.kind === 'delta') return event.item.itemId
  if (event.item.kind === 'partial') return streamItemIdOf(event.item.item)
  return undefined
}

/**
 * GIVE A FINE WATCH A BOUNDED MOMENT TO BECOME REAL.
 *
 * `watch('fine')` resolves as soon as the refcount moves, deliberately: it must
 * hand a viewer its release function immediately, and for two of the three
 * headless families the level is live by then. Codex is the exception, and the
 * reason is structural rather than incidental — its handshake opts OUT of delta
 * notifications, so upgrading is a reconnect: a second connection, a
 * `thread/resume`, and a swap. A corpus that sent the instant `watch` resolved
 * would be measuring the race, not the driver.
 *
 * A FIXED WAIT, NOT A POLL, because there is nothing to poll: the contract
 * exposes no "which level is live now", by the same argument. The consequence is
 * stated rather than hidden — a driver whose fine watch takes longer than this
 * fails these properties LOUDLY, which is correct: the daemon's watch lifecycle
 * has the same problem and needs the same budget, and a silent skip here would
 * be the corpus declining to notice.
 */
const settleWatch = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

/**
 * The one read loop both drains are, with the deadline handled properly
 * (POD-2085, from POD-2023's review 4d).
 *
 * THREE THINGS THE TWO HAND-WRITTEN COPIES GOT WRONG, all invisible in the
 * corpus today and none of them invisible for long:
 *
 *   1. The deadline timer was created once at entry and never cleared, so an
 *      early match left a live timer holding a resolve nobody would read. The
 *      `unref` kept that from wedging the process, which is a mitigation, not a
 *      fix — and `unref` does not exist in every runtime the contract package
 *      claims to support.
 *   2. When the timeout won, the in-flight `iterator.next()` was ABANDONED —
 *      still pending, and now the only thing holding the generator. If it later
 *      rejects, the rejection is unhandled and lands on whichever test happens
 *      to be running when it fires.
 *   3. `await iterator.return?.()` then ran against that pending read. An async
 *      generator queues `return()` behind the read it is suspended in, so
 *      awaiting it on a driver parked waiting for an event NEVER RESOLVES — the
 *      helper hangs past the very deadline the timeout exists to enforce, which
 *      is the hung-gate failure mode {@link drain}'s own header calls the worst
 *      one a conformance corpus can have.
 *
 * So: the timer is always cleared, the abandoned read is explicitly disowned,
 * and `return()` is awaited only on the paths where nothing is in flight.
 */
async function collectUntil(
  stream: AsyncIterable<RuntimeEvent>,
  stop: (event: RuntimeEvent, taken: number) => boolean,
  timeoutMs: number,
): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  const iterator = stream[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    // Never hold the process open on the corpus's account.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
  try {
    while (true) {
      const pending = iterator.next()
      const next = await Promise.race([pending, deadline])
      if (next === 'timeout') {
        // Disowned, not awaited: the read may never resolve, and a rejection
        // with no handler would surface inside an unrelated property.
        void pending.catch(() => {})
        void iterator.return?.().catch(() => {})
        return out
      }
      if (next.done) break
      out.push(next.value)
      if (stop(next.value, out.length)) break
    }
    // No read in flight here, so `return()` runs against a generator suspended
    // at a yield and settles immediately.
    await iterator.return?.()
    return out
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait for something a driver reaches ASYNCHRONOUSLY, or give up and let the
 * property state what it found.
 *
 * WHY POLLING RATHER THAN AN AWAIT. A queue drains when the PROVIDER goes idle:
 * the fake does it inside `completeTurn`, opencode does it when the SSE frame
 * announcing idle comes back over a real loopback socket, and the terminal
 * driver does it from a ready-poll that watches PTY output timing. There is no
 * promise the corpus can hold for that, and inventing a control verb for it
 * would be asking every driver to expose its own drain — the thing the contract
 * deliberately keeps private. The bound is the same 2s the drains use, for the
 * same reason: a driver that never gets there must FAIL rather than hang.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    })
  }
  return true
}

/**
 * THERE IS DELIBERATELY NO `settle(ms)` HELPER HERE (POD-2085 review, finding 2).
 *
 * One existed: a fixed wait, used by the anti-substitution property to give a
 * drain "room to happen" before asserting that nothing had. It was a bet on a
 * number — 250ms against a terminal drain whose floor is 800ms one directory
 * over — and the reviewer collected on it with a 400ms impostor that passed.
 * A corpus property that can be beaten by being slow is worse than no property,
 * because it reads as coverage. {@link waitUntil} waits for something that must
 * HAPPEN and stops the moment it does; nothing here waits out something that
 * must not, because the invariants are stated where they have definite answers
 * instead.
 */
const seqOf = (event: RuntimeEvent): number => Number(event.cursor.components.seq ?? 0)

const attachmentSourceFor = (kind: AttachmentKind): AttachmentSource =>
  kind === 'image'
    ? {
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        filename: 'probe.png',
        mediaType: 'image/png',
      }
    : {
        bytes: new TextEncoder().encode('attachment probe'),
        filename: 'probe.txt',
        mediaType: 'text/plain',
      }

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
          'staging',
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

      it('cannot declare an ARCHIVE it has no resume ref to put in one', () => {
        const { driver } = setup()
        const caps = driver.capabilities()
        if (caps.resumeRefTiming !== 'never') return
        /**
         * TWO DECLARATIONS THAT CANNOT BOTH BE TRUE (POD-2703).
         *
         * `SessionArchive.resume` is not optional, and the archive guarantee is
         * that an archive suffices to CONTINUE the conversation on another
         * machine. A driver whose harness never mints a resume ref has nothing
         * to put in that field, so an archive it produced could only carry a
         * fabricated one — a backup that restores into a conversation that does
         * not exist. The honest declaration is `unsupported`, with the reason a
         * human reads in `podium doctor`.
         *
         * Checked here rather than left to the export properties because a
         * capability pair that contradicts itself is wrong before any verb runs,
         * and because this is the one cross-axis constraint the type system
         * cannot state: both axes are independently well-typed.
         */
        expect(
          caps.archive.supported,
          'a driver that never mints a resume ref cannot declare an archive',
        ).toBe(false)
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
    // Attachment staging
    // -----------------------------------------------------------------------

    describe('attachment staging', () => {
      it('returns a staged ref matching its declaration, or a typed refusal', async () => {
        const { handle, driver } = setup()
        const session = await handle
        const declared = driver.capabilities().staging

        if (!declared.supported) {
          await expect(
            session.stageAttachment(attachmentSourceFor('image')),
          ).resolves.toMatchObject({ reason: 'unsupported' })
          return
        }

        const declaredKinds = [...declared.value.kinds]
        expect(declaredKinds.length).toBeGreaterThan(0)
        expect(new Set(declaredKinds).size).toBe(declaredKinds.length)
        for (const kind of declaredKinds) expect(['image', 'file']).toContain(kind)
        // STRUCTURAL ONLY. This prevents an invented prompt-form value and the
        // impossible local-image/file pairing; it does not prove that send()
        // presents a staged ref in the declared form. That requires a driver
        // boundary test with an observable provider prompt.
        expect(['path-text', 'local-image', 'file-part']).toContain(declared.value.promptForm)
        if (declared.value.promptForm === 'local-image') expect(declaredKinds).toEqual(['image'])

        for (const kind of ['image', 'file'] as const) {
          const source = attachmentSourceFor(kind)
          if (!declaredKinds.includes(kind)) {
            await expect(session.stageAttachment(source)).resolves.toMatchObject({
              reason: 'unsupported',
            })
            continue
          }
          const staged = await session.stageAttachment(source)
          expect(staged).not.toHaveProperty('reason')
          if ('reason' in staged) continue
          expect(staged).toMatchObject({
            id: expect.any(String),
            path: expect.any(String),
            filename: source.filename,
            mediaType: source.mediaType,
            kind,
          })
          expect(staged.id.length).toBeGreaterThan(0)
          expect(staged.path.length).toBeGreaterThan(0)
        }

        await session.kill()
        await expect(
          session.stageAttachment(attachmentSourceFor(declaredKinds[0] ?? 'file')),
        ).resolves.toMatchObject({ reason: 'not_running' })
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
        expect(control.textDeliveries(session.binding.sessionId)).toBe(1)
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
        control.askInteraction(session.binding.sessionId, 'permission')
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
          // THE LIST CANNOT ROT IN THE OTHER DIRECTION EITHER (POD-2085 review,
          // finding 6). Everything else about `NO_NATIVE_STEER_DRIVERS` is
          // asserted on the branch below, which a driver with native steer never
          // reaches — so a driver that GAINS a steer verb would leave a stale
          // permission on the list with nothing to trip over it. An entitlement
          // is a record of an absence; when the absence ends, so does it.
          expect(
            permitsNoNativeSteer(driver.id),
            `driver '${driver.id}' has native steer AND is listed as entitled to decline it — remove it from NO_NATIVE_STEER_DRIVERS`,
          ).toBe(false)
          return
        }
        // The permitted failure is the DOWNGRADE, never the silence. Whatever
        // the outcome, `deliveredAs` must say what really happened.
        //
        // AND THE EXEMPTION IS THIS DRIVER'S, NOT ITS FAMILY'S (POD-2085). The
        // family row alone stopped meaning anything the moment `no-native-steer`
        // went on all three of them; the driver-id pin is what makes inheriting
        // it an edit somebody has to make on purpose. See
        // `../../permitted-failures.ts`.
        assertNoNativeSteerEntitled(target.family, driver.id)
        expect(receipt.outcome === 'queued' || receipt.outcome === 'accepted').toBe(true)
        if (receipt.outcome === 'queued' || receipt.outcome === 'accepted') {
          expect(receipt.deliveredAs).not.toBe('steer')
          expectDeclaredDelivery(driver.capabilities(), receipt)
        }
      })

      it('never reports a delivery it did not declare native', async () => {
        /**
         * THE TEETH THAT REPLACE THE FAMILY PERMISSION (POD-2023).
         *
         * `no-native-steer` is now permitted to all three families — W5 measured
         * opencode and found steering to be a per-HARNESS protocol verb rather
         * than a family property (see `../../permitted-failures.ts`). That makes
         * `permits(family, 'no-native-steer')` above true for everyone and
         * therefore worth nothing on its own. POD-2085 put a gate back where the
         * fact lives, by pinning the DRIVER IDS entitled to the row; this
         * property is the other half, and it stayed as written.
         *
         * What is worth something is the DECLARATION: `send.native` says, per
         * driver, which deliveries are real. This property pins both directions
         * of it across every delivery mode the corpus can reach — a driver may
         * not answer with a `deliveredAs` it never claimed it could perform, and
         * a driver that claims one must actually use it when asked. That bites
         * on every family, which is exactly what the family permission stopped
         * doing.
         */
        const { handle, driver } = setup()
        const session = await handle
        const capabilities = driver.capabilities()
        const first = await session.send(
          { text: 'one' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expectDeclaredDelivery(capabilities, first)
        const queued = await session.send({ text: 'two' }, { origin: 'human', delivery: 'queue' })
        expectDeclaredDelivery(capabilities, queued)
        // The requested mode, when the driver says it is native, is the mode
        // that must come back. Otherwise the declaration describes nothing.
        if (capabilities.send.native.includes('when-ready') && first.outcome !== 'refused') {
          expect(first.deliveredAs).toBe('when-ready')
        }
      })

      it('DOES what `deliveredAs: steer` says — the substitution nothing else catches', async () => {
        /**
         * DELIVERY SEMANTICS, NOT DELIVERY VOCABULARY (POD-2085).
         *
         * Everything above this line checks what a receipt SAYS.
         * `expectDeclaredDelivery` catches a driver naming a mode absent from its
         * own `send.native`, and the downgrade property catches a driver that
         * says `steer` having declared it cannot. Neither catches the case in
         * between, which is the one that costs a caller work: a driver that
         * declares `steer` native, answers a steer request with
         * `deliveredAs: 'steer'`, and QUEUES the words. Every property passes.
         * The steward believes its correction reached the running turn; the
         * agent finishes the turn without it and reads the correction afterwards
         * as a fresh instruction, which for a "stop, you're editing the wrong
         * file" is the difference between a nudge and a second wrong edit.
         *
         * THE WITNESS IS THE DELIVERY, AND IT IS READ AT RECEIPT TIME — which is
         * what makes this check race-free (POD-2085 review, finding 2). The
         * first version waited a fixed 250ms after fencing the turn and then
         * asserted no new epoch had appeared, so an impostor whose queue drained
         * a little later simply outlasted the corpus; the reviewer built one at
         * 400ms and it passed, and the terminal family's own drain cannot even
         * type sooner than `READY_FLOOR_MS` = 800ms. Racing an unknown drain
         * with a fixed sleep is not a test, it is a bet.
         *
         * There is nothing to race, because `accepted` already means the
         * provider took the words. So the question is asked at the only moment
         * with a definite answer: the instant the receipt resolves, had the
         * caller's text reached the agent? A steer says yes by definition. An
         * impostor holding the words in a queue says no, however honest its
         * receipt fields look, and it cannot make the answer true later without
         * also opening the turn its receipt swore it did not open.
         */
        const { handle, control } = setup()
        const session = await handle
        const sessionId = session.binding.sessionId
        const opened = await session.send(
          { text: 'open a turn' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(opened.outcome).toBe('accepted')
        if (opened.outcome !== 'accepted') return
        const openEpoch = opened.turnEpoch
        const before = control.textDeliveries(sessionId)

        const receipt = await session.send(
          { text: 'and this too' },
          { origin: 'mail', delivery: 'steer' },
        )
        // A refusal delivered nothing, so there are no semantics to check. The
        // downgrade property above already pins which outcomes are legal here.
        if (receipt.outcome === 'refused' || receipt.outcome === 'unverified') return

        if (receipt.deliveredAs === 'steer') {
          const epochAfterReceipt = (await session.snapshot()).turnEpoch
          const afterReceipt = control.textDeliveries(sessionId)
          // THE FENCE IS THE SECOND QUESTION, not a second chance at the first.
          // A steer's words were already in this turn, so its ending must not
          // deliver anything — while a queue that was calling itself a steer
          // drains exactly here. See the assertion's own note for what this
          // does and does not catch.
          await control.completeTurn(sessionId)
          assertSteerJoinedOpenTurn({
            receipt,
            openEpoch,
            epochAfterReceipt,
            textDeliveries: {
              before,
              afterReceipt,
              afterFence: control.textDeliveries(sessionId),
            },
          })
          return
        }

        // THE OTHER HALF: a reported queue must be a real queue, in both
        // directions. `deliveredAs: 'queue'` promises the caller two things —
        // the words are NOT with the agent yet, and they will be — and a driver
        // that breaks either one has told them their work is somewhere it is
        // not.
        expect(receipt.deliveredAs).toBe('queue')
        expect(
          control.textDeliveries(sessionId),
          'a receipt said `queue` while the words had already gone to the agent — that is a send wearing a queue label',
        ).toBe(before)
        await control.completeTurn(sessionId)
        const delivered = await waitUntil(() => control.textDeliveries(sessionId) > before)
        expect(delivered, 'a queued turn was never delivered after the turn fenced').toBe(true)
        /**
         * WHY THE EPOCH IS NOT ASSERTED ON THIS SIDE, deliberately and after
         * measuring it (POD-2085). The mirror of the steer branch would be "a
         * queued turn MUST open a new epoch". It is true of the drivers that
         * mint their own — the fake and opencode both advance on the drained
         * delivery — and NOT observable on the terminal family, where the epoch
         * is minted by the causal observer from the harness's own signals and a
         * `snapshot()` taken between the drain and the next observation honestly
         * reports the epoch nobody has revised yet. Asserting it would fail a
         * driver for the observer's latency, which says nothing about delivery.
         *
         * The trade was worth naming rather than assuming (review round 1,
         * finding 1). What this branch proves is that the words REACHED THE
         * AGENT after the fence, which is the part a caller's work depends on.
         *
         * The separate turn-fence property now proves the premise this note once
         * assumed: a second provider terminal signal emits no second terminal
         * event and does not move the epoch. Its later provider ask is the
         * ordering witness, so that absence is not inferred from a fixed wait.
         */
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
        expect(control.textDeliveries(session.binding.sessionId)).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    // Interactions
    // -----------------------------------------------------------------------

    describe('interactions', () => {
      it('asked → answered, and the ask is enumerable while open', async () => {
        const { handle, control } = setup()
        const session = await handle
        const id = control.askInteraction(session.binding.sessionId, {
          kind: 'permission',
          payload: { v: 1, toolName: 'Bash', inputSummary: 'ls', canAlwaysAllow: false },
        })
        const open = await session.interactions()
        // "Stuck" is supposed to be impossible to hide: a blocked session is BY
        // CONSTRUCTION a session with an open interaction (spec §4).
        expect(open.map((i: PendingInteraction) => i.id)).toContain(id)
        expect(await session.answer(id, { decision: 'allow' })).toEqual({ ok: true })
        expect(await session.interactions()).toHaveLength(0)
      })

      it('an OPEN ask is visible in state(), not only on the event stream', async () => {
        /**
         * THE PROPERTY THAT WAS MISSING, AND THE ONE W5's REVIEW CAUGHT A DRIVER
         * THROUGH (POD-2023).
         *
         * The corpus pinned `needs_user` only as a REFUSAL REASON on a receipt,
         * so it never asked whether the session's own PROJECTION agrees with its
         * event stream. A driver could emit `{t:'state', change:{kind:'needs_user'}}`
         * and leave `state()` reporting `working` — which is exactly what the
         * opencode driver did for one release: the PendingInteraction row
         * appeared, the badge stayed "working" for as long as the human took to
         * answer, and every attention surface that reads the phase stayed quiet.
         *
         * Spec §4's claim is that "a blocked session is BY CONSTRUCTION a session
         * with an open interaction". That has to hold on BOTH readers of a driver
         * — `interactions()` and `state()` — or the two disagree about the one
         * thing a stuck session is defined by. This asserts them together.
         */
        const { handle, control, driver } = setup()
        const session = await handle
        const declared = driver.capabilities().interactions
        if (!declared.supported) return
        const before = (await session.state()).phase
        expect(before).not.toBe('needs_user')

        const id = control.askInteraction(session.binding.sessionId, 'permission')
        expect((await session.interactions()).map((i) => i.id)).toContain(id)
        // THE PROJECTION, not the stream. `snapshot()` carries the same value for
        // the same reason: a consumer bootstrapping mid-block must see the block.
        expect((await session.state()).phase).toBe('needs_user')
        expect((await session.snapshot()).state.phase).toBe('needs_user')

        /**
         * …AND THE ASK ITSELF CLOSES, whichever way the answer went.
         *
         * A driver is ENTITLED to refuse: the terminal family declines
         * keystroke-emulated permissions outright (POD-707 — the native menu's
         * ordinals vary per ask, so a denial can approve), and that refusal is a
         * feature. Refused means the ask stays open, which is the whole point of
         * refusing rather than degrading.
         *
         * WHAT IS DELIBERATELY *NOT* ASSERTED HERE: that the phase leaves
         * `needs_user` after a successful answer. That is not family-invariant,
         * and discovering why is what this property is worth beyond its forward
         * direction. For a SERVER driver the driver IS the observer — it saw the
         * ask arrive on its own protocol and it sees the reply land, so it owns
         * the projection and must move it. For a TERMINAL driver the phase comes
         * from an EXTERNAL observer watching the screen: answering types digits,
         * and the transition out of `needs_user` is the observer's to report when
         * the menu actually closes. A terminal driver that moved the phase itself
         * would be fabricating state it has not observed — exactly what the
         * causal contract forbids, and a worse failure than reporting it late.
         *
         * The FORWARD direction above is the invariant, and it is the one spec §4
         * rests on: a session with an open ask reports itself blocked.
         */
        const answered = await session.answer(id, { decision: 'allow' })
        const stillOpen = (await session.interactions()).map((i) => i.id)
        expect(stillOpen.includes(id)).toBe(!answered.ok)
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
        const { handle, control, driver } = setup()
        const session = await handle
        const declared = driver.capabilities().interactions
        if (!declared.supported) return
        /**
         * THE PROPERTY IS ABOUT PHASE, NOT ABOUT KIND COVERAGE — and it is asked
         * in a kind THIS DRIVER DECLARES (POD-2023).
         *
         * Resume-time recovery prompts are the motivating case: they are asked
         * while the handle is still STARTING, and a driver that gated
         * interactions on a running turn would strand every background executor
         * at boot. But `recovery` is a kind only some harnesses have a channel
         * for — opencode's protocol carries `permission` and `question` and
         * nothing else — and hardcoding it here would have forced a server
         * driver to fabricate an ask its harness cannot produce in order to pass
         * a property about timing.
         *
         * So the kind comes from the capability declaration, which makes this
         * STRICTER rather than looser: a driver must now be able to produce, at
         * boot, an ask of a kind it publicly claims — and a driver that claimed
         * `recovery` still has to deliver `recovery`.
         */
        const kinds = declared.value.kinds
        const kind = kinds.includes('recovery') ? 'recovery' : kinds[0]
        if (!kind) return
        const id = control.askInteraction(session.binding.sessionId, defaultAskFor(kind))
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

        // Provider confirmation is what fences it. Everything the driver emits
        // in between — liveness heartbeats, transcript items — is allowed; what
        // is pinned is that a TURN event arrives only now, and the assertion
        // above already proved none arrived before.
        await control.completeTurn(session.binding.sessionId)
        const events = await drainUntil(session.events(before.cursor), (e) => e.t === 'turn')
        expect(events.filter((e) => e.t === 'turn').length).toBeGreaterThan(0)
      })
    })

    // -----------------------------------------------------------------------
    // Fine watch: the token-fragment stream, and the join that makes it usable
    // (POD-2293). The corpus asserted NOTHING about `kind:'delta'` before this
    // group, which is how opencode shipped fragments that joined to no item for
    // three work items — every driver test that exercised deltas synthesized
    // them, and a synthesized fragment agrees with whatever the test invented.
    // -----------------------------------------------------------------------

    describe('fine watch — token fragments', () => {
      const CHUNKS = ['Hel', 'lo, ', 'world'] as const
      const WHOLE = CHUNKS.join('')

      it('supplies a fragment stream EXACTLY when it declares `fine`', () => {
        const { driver, control } = setup()
        const declared = driver.capabilities().observation.watchLevels.includes('fine')
        // The converse is the half that matters. A driver declaring `fine` with
        // no way to induce a fragment would make every property below vacuous,
        // and a green suite that proves nothing is worse than a red one.
        expect(
          typeof control.streamAssistantText === 'function',
          declared
            ? `driver declares watch level 'fine' but its control cannot stream a reply`
            : `driver declares no 'fine' watch level but its control streams fragments`,
        ).toBe(declared)
      })

      it('emits NO fragment while every watcher is coarse', async () => {
        const { handle, control, driver } = setup()
        if (!driver.capabilities().observation.watchLevels.includes('fine')) return
        const session = await handle
        const release = await session.watch('coarse')
        await settleWatch()
        const receipt = await session.send(
          { text: 'quiet' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        const collected = drainUntil(
          session.events('bootstrap'),
          (e) => e.t === 'turn' && (e.ev.ev === 'completed' || e.ev.ev === 'failed'),
          3000,
        )
        await control.streamAssistantText?.(session.binding.sessionId, CHUNKS)
        await control.completeTurn(session.binding.sessionId)
        const events = await collected
        release()
        expect(events.filter(isFineOnlyEvent)).toEqual([])
      })

      it('streams fragments under a fine watch, and every one joins its completed item', async () => {
        const { handle, control, driver } = setup()
        if (!driver.capabilities().observation.watchLevels.includes('fine')) return
        const session = await handle
        const release = await session.watch('fine')
        await settleWatch()
        const receipt = await session.send(
          { text: 'stream it' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        const collected = drainUntil(
          session.events('bootstrap'),
          (e) => e.t === 'turn' && (e.ev.ev === 'completed' || e.ev.ev === 'failed'),
          3000,
        )
        await control.streamAssistantText?.(session.binding.sessionId, CHUNKS)
        await control.completeTurn(session.binding.sessionId)
        const events = await collected
        release()

        const deltas = events.filter(isDeltaEvent)
        expect(deltas.length, 'a fine watcher saw no fragments at all').toBeGreaterThan(0)

        // THE JOIN. Every fragment must name an item the same turn completed, by
        // the contract's own identity function — which is the assertion opencode
        // could not pass before POD-2293, because its fragments carried a raw
        // part id and its items carried a stamped cursor.
        const completedIds = new Set<string>()
        for (const event of events) {
          if (event.t !== 'item' || event.item.kind !== 'complete') continue
          completedIds.add(streamItemIdOf(event.item.item))
        }
        for (const event of events.filter(isFineOnlyEvent)) {
          const claimed = fineOnlyStreamId(event)
          expect(
            claimed !== undefined && completedIds.has(claimed),
            `live-only item '${claimed}' joins no completed item in this turn ` +
              `(completed: ${[...completedIds].join(', ') || 'none'})`,
          ).toBe(true)
        }

        // THE FRAGMENTS ARE A PREFIX OF WHAT LANDED, not an independent second
        // copy of it. Stated as a prefix rather than as equality because the
        // families differ in what else the item may pick up before it closes —
        // grok flushes ONE buffered item at the fence, so a provider chunk
        // emitted between the reply and the terminal is part of the same item —
        // and because the contract lets a consumer miss any prefix of a fragment
        // stream. What a driver may NOT do is re-send the whole reply per
        // fragment, or emit text the item never contained, and both fail here.
        const completedText = new Map<string, string>()
        for (const event of events) {
          if (event.t !== 'item' || event.item.kind !== 'complete') continue
          completedText.set(streamItemIdOf(event.item.item), event.item.item.text ?? '')
        }
        const byItem = new Map<string, string>()
        for (const delta of deltas) {
          byItem.set(
            delta.item.itemId,
            (byItem.get(delta.item.itemId) ?? '') + delta.item.textDelta,
          )
        }
        for (const [itemId, streamed] of byItem) {
          const landed = completedText.get(itemId) ?? ''
          expect(
            landed.startsWith(streamed),
            `fragments for '${itemId}' are not a prefix of the item that landed:\n` +
              `  fragments: ${JSON.stringify(streamed)}\n  item:      ${JSON.stringify(landed)}`,
          ).toBe(true)
        }
        expect([...byItem.values()].join('')).toContain(WHOLE)
      })

      it('stamps every fragment with the OPEN turn epoch, never a fenced one', async () => {
        const { handle, control, driver } = setup()
        if (!driver.capabilities().observation.watchLevels.includes('fine')) return
        const session = await handle
        const release = await session.watch('fine')
        await settleWatch()
        const receipt = await session.send(
          { text: 'epoch' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        if (receipt.outcome !== 'accepted') return
        const collected = drainUntil(
          session.events('bootstrap'),
          (e) => e.t === 'turn' && (e.ev.ev === 'completed' || e.ev.ev === 'failed'),
          3000,
        )
        await control.streamAssistantText?.(session.binding.sessionId, CHUNKS)
        await control.completeTurn(session.binding.sessionId)
        const events = await collected
        for (const event of events.filter(isFineOnlyEvent)) {
          expect(event.turnEpoch).toBe(receipt.turnEpoch)
        }

        // AND NOTHING AFTER THE FENCE. A late fragment for a closed epoch is the
        // absorb rule stated in fragment terms: the preview it would revive was
        // already replaced by the durable item.
        const after = drainUntil(
          session.events(events.at(-1)?.cursor ?? 'bootstrap'),
          isDeltaEvent,
          400,
        )
        await control.streamAssistantText?.(session.binding.sessionId, ['late'])
        expect((await after).filter(isFineOnlyEvent)).toEqual([])
        release()
      })

      it('stops streaming once the last fine watcher releases', async () => {
        const { handle, control, driver } = setup()
        if (!driver.capabilities().observation.watchLevels.includes('fine')) return
        const session = await handle
        const release = await session.watch('fine')
        await settleWatch()
        release()
        const receipt = await session.send(
          { text: 'released' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        const collected = drainUntil(
          session.events('bootstrap'),
          (e) => e.t === 'turn' && (e.ev.ev === 'completed' || e.ev.ev === 'failed'),
          3000,
        )
        await control.streamAssistantText?.(session.binding.sessionId, CHUNKS)
        await control.completeTurn(session.binding.sessionId)
        expect((await collected).filter(isFineOnlyEvent)).toEqual([])
      })
    })

    describe('turn fences', () => {
      it('absorbs a second terminal signal for an already-fenced epoch', async () => {
        const { handle, control } = setup()
        const session = await handle
        const receipt = await session.send(
          { text: 'finish once' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        if (receipt.outcome !== 'accepted') return
        const open = await session.snapshot()
        await control.completeTurn(session.binding.sessionId)
        const terminal = await drainUntil(
          session.events(open.cursor),
          (event) =>
            event.t === 'turn' &&
            event.ev.ev !== 'started' &&
            event.ev.turnEpoch === receipt.turnEpoch,
        )
        expect(terminal.filter((event) => event.t === 'turn')).toHaveLength(1)
        const fenced = await session.snapshot()

        await control.completeTurn(session.binding.sessionId)
        const witness = control.askInteraction(session.binding.sessionId, 'permission')
        // The later provider ask is the ordering witness: every terminal signal
        // that preceded it has reached the fold, without betting on a timeout.
        const events = await drainUntil(
          session.events(fenced.cursor),
          (event) =>
            event.t === 'interaction' &&
            event.ev.ev === 'asked' &&
            event.ev.interaction.id === witness,
        )

        expect(events.filter((event) => event.t === 'turn')).toHaveLength(0)
        expect((await session.snapshot()).turnEpoch).toBe(fenced.turnEpoch)
      })

      it('absorbs repeated failure terminals and a later idle for the same epoch', async () => {
        const { handle, control } = setup()
        const failTurn = control.failTurn
        if (!failTurn) return
        const session = await handle
        const receipt = await session.send(
          { text: 'fail once' },
          { origin: 'human', delivery: 'when-ready' },
        )
        expect(receipt.outcome).toBe('accepted')
        if (receipt.outcome !== 'accepted') return
        const open = await session.snapshot()
        await failTurn(session.binding.sessionId, 'provider-error')
        const terminal = await drainUntil(
          session.events(open.cursor),
          (event) =>
            event.t === 'turn' &&
            event.ev.ev === 'failed' &&
            event.ev.turnEpoch === receipt.turnEpoch,
        )
        expect(terminal.filter((event) => event.t === 'turn')).toHaveLength(1)
        const fenced = await session.snapshot()

        await failTurn(session.binding.sessionId, 'provider-error')
        await control.completeTurn(session.binding.sessionId)
        const witness = control.askInteraction(session.binding.sessionId, 'permission')
        const events = await drainUntil(
          session.events(fenced.cursor),
          (event) =>
            event.t === 'interaction' &&
            event.ev.ev === 'asked' &&
            event.ev.interaction.id === witness,
        )

        expect(events.filter((event) => event.t === 'turn')).toHaveLength(0)
        expect((await session.snapshot()).turnEpoch).toBe(fenced.turnEpoch)
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
        await control.completeTurn(session.binding.sessionId)
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
        await control.completeTurn(session.binding.sessionId)
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
        await control.completeTurn(session.binding.sessionId)
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
    // Resume — the path where the process is GONE
    // -----------------------------------------------------------------------

    /**
     * WHY THIS BLOCK EXISTS BESIDE `adopt` RATHER THAN INSIDE IT (POD-2703).
     *
     * The corpus reached the post-restart world through `adopt()` alone, and
     * `adopt()` has a PRECONDITION this path does not: a SURVIVING PROCESS TREE.
     * Its own property one screen up says so — "refuses to adopt a binding whose
     * process did not survive". `resume()` is the other half of the same story,
     * and it is the half every user-visible promise rests on: hibernate-and-wake,
     * revival after a crash, handoff to another machine. Those all begin with the
     * process GONE, which is precisely where adopt is required to refuse.
     *
     * So a green adopt block says nothing at all about resume, and until this
     * block landed `resume()` was a CORE verb with no caller and no test outside
     * a `describe.skip` behind `PODIUM_CODEX_LIVE=1`. Under this milestone's rule
     * — a primitive that is declared but has no caller and no test is NOT
     * implemented — it was not implemented on any driver.
     *
     * THE FAILURE MODE THIS GUARDS is not a stack trace. A driver whose `resume`
     * ignores the ref and starts a FRESH conversation returns a perfectly good
     * handle; every existing property passes on it. What the user sees is a
     * session that came back empty, which reads as lost work rather than as a
     * driver bug. `binding.resume` equalling the ref that was asked for is the
     * cheapest thing that separates "resumed" from "quietly started over".
     */
    /**
     * A SESSION THAT HAS ACTUALLY HAD A CONVERSATION, and its resume ref if the
     * harness ever mints one.
     *
     * BOTH HALVES ARE LOAD-BEARING and each was learned rather than designed.
     * The TURN is not decoration: an archive taken from a session that has said
     * nothing is empty for an honest reason, so an export property standing on a
     * fresh handle cannot tell a driver that ships no bytes from one that had no
     * bytes to ship. And `resumeRefTiming: 'first-turn'` is the honest answer for
     * a harness whose store is written lazily (Codex's rollout files; the
     * terminal family's floor), so a corpus that only ever looked at a
     * freshly-created session would find `null` and conclude the family cannot
     * resume at all.
     */
    const afterOneTurn = async (
      session: AgentSessionHandle,
      control: ConformanceControl,
      timing: ResumeRefTiming,
    ): Promise<ResumeRef | null> => {
      await session.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
      await control.completeTurn(session.binding.sessionId)
      if (timing === 'never') return null
      await waitUntil(() => session.binding.resume !== null)
      return session.binding.resume
    }

    describe('resume — the path where the process is GONE', () => {
      it('mints the ref its capability promises, WHEN it promises it', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        const timing = driver.capabilities().resumeRefTiming
        if (timing === 'spawn') {
          // "Captured as EARLY as the harness allows" — for this family that is
          // before a single turn runs, and the declaration is what a caller
          // reads before deciding whether hibernation is safe.
          expect(session.binding.resume).not.toBeNull()
          return
        }
        await session.send({ text: 'work' }, { origin: 'human', delivery: 'when-ready' })
        await control.completeTurn(session.binding.sessionId)
        if (timing === 'never') {
          // A declaration that no ref is ever coming. It must stay true after a
          // turn, because a driver that quietly grows one has made `hibernate`'s
          // refusal a lie in the other direction.
          expect(await waitUntil(() => session.binding.resume !== null, 200)).toBe(false)
          return
        }
        // `first-turn`: the ref is the WHOLE content of the declaration, and
        // nothing checked it. A harness that never writes its store leaves the
        // session unresumable while the capability says otherwise.
        expect(
          await waitUntil(() => session.binding.resume !== null),
          'resumeRefTiming is `first-turn`, but no ref existed after one completed turn',
        ).toBe(true)
      })

      it('succeeds where adopt CANNOT — no survivor, same conversation', async () => {
        const { handle, control, driver, spec } = setup()
        const session = await handle
        const timing = driver.capabilities().resumeRefTiming
        const ref = await afterOneTurn(session, control, timing)
        if (!ref) {
          // Stated rather than skipped: the refusal is asserted below, in the
          // property that exists for exactly this driver.
          expect(timing).toBe('never')
          return
        }
        const dead = session.binding
        await session.kill()

        // THE PRECONDITION, PROVEN RATHER THAN ASSUMED. This is the same
        // assertion the adopt block makes, made here so the two paths are
        // separated by something the test can see: from this world, adopt is
        // required to refuse. Anything resume does next it does WITHOUT a
        // process tree to rebind to.
        await expect(driver.adopt(dead)).rejects.toThrow()

        const resumed = await driver.resume(ref, spec)
        // THE SAME CONVERSATION, NOT A FRESH ONE. A driver that discards the ref
        // and creates a new session passes every other property in this file.
        expect(resumed.binding.resume).toEqual(ref)
        expect(resumed.binding.driver).toBe(driver.id)
        expect(resumed.binding.family).toBe(driver.family)
        expect(resumed.binding.workdir).toBe(spec.workdir)

        // AND IT IS GENUINELY RUNNING. A handle whose process never came up
        // answers `not_running`, which is the difference between "resumed" and
        // "handed back an object shaped like a session".
        const receipt = await resumed.send(
          { text: 'still here?' },
          { origin: 'human', delivery: 'when-ready' },
        )
        if (receipt.outcome === 'refused') {
          expect(
            receipt.refusal.reason,
            `resume() returned a handle that refuses sends: ${receipt.refusal.reason}`,
          ).not.toBe('not_running')
        }
      })

      it('comes back as a working OBSERVATION source, not just a handle', async () => {
        const { handle, control, driver, spec } = setup()
        const session = await handle
        const timing = driver.capabilities().resumeRefTiming
        const ref = await afterOneTurn(session, control, timing)
        if (!ref) {
          expect(timing).toBe('never')
          return
        }
        await session.kill()
        const resumed = await driver.resume(ref, spec)

        // Exactly one snapshot opens a stream; everything after it is a
        // cursor-fenced live delta. A resumed session that cannot do that is
        // unwatchable, and the chat above it shows a session that came back
        // frozen — which is the same "lost work" the ref check guards, arriving
        // through observation instead of through identity.
        const bootstrap = await resumed.snapshot()
        expect(bootstrap.binding.resume).toEqual(ref)
        control.askInteraction(resumed.binding.sessionId, 'permission')

        const events = await drain(resumed.events(bootstrap.cursor), 1)
        expect(events.length).toBeGreaterThan(0)
        for (const event of events) {
          expect(seqOf(event)).toBeGreaterThan(Number(bootstrap.cursor.components.seq ?? 0))
          // Post-bootstrap events are LIVE. A replay must say so instead.
          expect(event.provenance).not.toBe('bootstrap')
        }
      })

      it('REFUSES when the harness has no resume at all — never a fresh session', async () => {
        const { handle, driver, spec } = setup()
        const session = await handle
        if (driver.capabilities().resumeRefTiming !== 'never') {
          // Unreachable BY CONSTRUCTION on this driver rather than by omission:
          // its harness does mint a ref, so there is no refusal to reach. Say so
          // instead of pretending to test it.
          expect(await session.hibernate()).not.toMatchObject({ reason: 'unsupported' })
          return
        }
        expect(session.binding.resume).toBeNull()
        // Hibernating a session we cannot bring back is data loss wearing a
        // lifecycle verb's name — and the same fact must reach `resume()`.
        expect(await session.hibernate()).toMatchObject({ reason: 'no_resume_ref' })
        // REFUSE, DO NOT DEGRADE. `resume()` returns a handle or nothing; there
        // is no refusal channel in its type, so the only honest answer is to
        // reject. Returning a fresh session here is the silent degradation this
        // milestone's test bar exists to catch: the caller believes the
        // conversation came back, and it did not.
        await expect(
          driver.resume({ kind: 'fabricated', value: 'no-such-conversation' }, spec),
          'a driver declaring `resumeRefTiming: never` must reject resume(), not start a fresh session',
        ).rejects.toThrow()
      })
    })

    // -----------------------------------------------------------------------
    // Export — the portable archive
    // -----------------------------------------------------------------------

    /**
     * THE ARCHIVE GUARANTEE, PINNED AS FAR AS IT CAN BE PINNED TODAY (POD-2703).
     *
     * `export()` is core because handoff, cloud migration, disaster recovery and
     * scheduled backup all rest on it — and until this block landed the only
     * test of it anywhere drove the in-memory fake. What made that comfortable is
     * that a broken `export` looks like nothing at all: an archive with no files,
     * or with absolute paths, or naming a different conversation than the session
     * it came from, is a well-formed object that only fails on the destination
     * machine, months later, when somebody needs it.
     *
     * WHAT IS NOT PROVED HERE, stated so nobody reads more into a green run than
     * it carries: `runtime.import()` throws on the daemon (blocked on POD-2415),
     * so there is no end-to-end archive round-trip anywhere in the tree. What IS
     * provable without it is the half of the guarantee that lives on the SOURCE
     * machine — the archive is complete, self-describing, machine-independent and
     * names the right conversation — plus the export→resume join at the bottom of
     * this block, which is the handoff story minus the file transfer.
     */
    describe('export — the portable archive', () => {
      it('produces the archive its capability DECLARES, or refuses to produce one', async () => {
        const { handle, control, driver } = setup()
        const session = await handle
        await afterOneTurn(session, control, driver.capabilities().resumeRefTiming)
        // The judgement lives in an exported function for the same reason
        // `assertAttachHonoursOneControlLease` does: a driver whose capability
        // varies with a HOST fact — the terminal family's `archivable` is one,
        // and it flips this property from "produce" to "refuse" — reaches only
        // one of the two arms under its own `runConformance` pass. Its fixture
        // builds the other world and is judged by this same function rather than
        // by a copy of it.
        await assertArchiveHonoursItsDeclaration(session, driver)
      })

      it('REFUSES before the harness has minted a resume ref', async () => {
        const { driver, spec } = setup()
        // A FRESH session, deliberately: no turn, so a lazily-written harness
        // store does not exist yet. A driver whose ref arrives at spawn has this
        // refusal unreachable BY CONSTRUCTION rather than by omission, and the
        // judgement below says which of the two worlds it is in.
        const session = await driver.create(spec)
        if (session.binding.resume) {
          // `resumeRefTiming: 'spawn'` — the ref exists from the moment the
          // handle does, so this refusal is unreachable BY CONSTRUCTION on this
          // driver rather than by omission. Say so, and assert the thing that IS
          // true: the archive of a session that has not spoken yet still names
          // the conversation it is on. (The full judgement is deliberately not
          // run here — it requires bytes, and a session with no turn honestly
          // has none.)
          expect(driver.capabilities().resumeRefTiming).toBe('spawn')
          const declared = driver.capabilities().archive
          if (declared.supported) {
            expect((await session.export()).resume).toEqual(session.binding.resume)
          }
          return
        }
        await assertArchiveHonoursItsDeclaration(session, driver)
      })

      it('EXPORT → RESUME: the half of the guarantee that needs no import', async () => {
        const { handle, control, driver, spec } = setup()
        const session = await handle
        if (!driver.capabilities().archive.supported) return
        await afterOneTurn(session, control, driver.capabilities().resumeRefTiming)
        const archive = await session.export()
        await session.kill()

        /**
         * THE ROUND TRIP, AS FAR AS IT GOES TODAY. `runtime.import()` throws on
         * the daemon (POD-2415), so the FILES half of the archive cannot be
         * landed on another machine and resumed from there by anything in this
         * tree. The REF half can be, and it is the half that fails silently:
         * a driver whose export ships a ref its own `resume()` cannot address
         * produces backups that are unusable by the very driver that wrote them,
         * and no test between here and POD-2415 would have said so.
         */
        const resumed = await driver.resume(archive.resume, spec)
        expect(resumed.binding.resume).toEqual(archive.resume)
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

      it('is ONE control lease and unlimited spectators — in both modes', async () => {
        /**
         * THE MODE WAS NEVER EXERCISED (POD-2085 review, and spec §5).
         *
         * Until this property the corpus made exactly one `attach` call, in
         * `peek` mode, and looked only at the shape that came back. `takeover`
         * — the mode with an INVARIANT attached to it — was never asked for by
         * any driver's conformance run, on any family. That is not a small gap:
         * "exactly one driver-controller or one human-controller holds it" is
         * what makes "the user attached and started typing" and "the steward
         * tried to nudge" impossible to interleave, and it is enforced in three
         * separate driver implementations that nothing compared.
         *
         * The assertions live in {@link assertAttachHonoursOneControlLease} so
         * the corpus's own teeth tests can drive them with a driver built to
         * break each one — see `fake.test.ts`. That is not a style preference:
         * this property's two refusal assertions were DORMANT on every landed
         * target when it was written, so without a construction that reaches
         * them they were the two nobody could ever show had bitten (review
         * round 2, finding 2).
         *
         * THEY ARE NO LONGER DORMANT, and the export is how they stopped being.
         * Each server-family fixture now also builds a world whose HOST refuses
         * to start a client terminal and calls this function against it
         * directly: `hostsClientTerminals: false` reaches the refused peek
         * (POD-2121), `'spectators-only'` reaches the refused take-over
         * (POD-2131 for opencode, POD-2486 for codex and grok-acp). The plain
         * `runConformance` pass below still takes the endpoint branch on every
         * target, because an ordinary machine hosts a terminal — which is why
         * those worlds are separate `describe`s in the driver files and not a
         * flag on the corpus.
         */
        const { handle, driver } = setup()
        await assertAttachHonoursOneControlLease(await handle, driver.capabilities(), target.family)
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
/**
 * The receipt's delivery must be one the driver DECLARED it can perform.
 *
 * The `deliveredAs` twin of {@link expectDeclaredProof}, and it exists for the
 * same reason one level down: `deliveredAs` is the field that makes a degraded
 * delivery visible instead of silent, and a driver reporting a mode absent from
 * its own `send.native` has described a mechanism it does not have. A consumer
 * branching on the declaration then branches on a lie — which is precisely what
 * the `steer` downgrade case is supposed to expose rather than commit.
 */
function expectDeclaredDelivery(capabilities: DriverCapabilities, receipt: TurnReceipt): void {
  if (receipt.outcome === 'refused') return
  expect(
    capabilities.send.native,
    `receipt claims delivery '${receipt.deliveredAs}', which this driver never declared native`,
  ).toContain(receipt.deliveredAs)
}

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
 * THE ARCHIVE, JUDGED AGAINST WHAT THE DRIVER SAID IT WOULD BE (POD-2703).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION AND NOT A PROPERTY BODY
 * ---------------------------------------------------------------------------
 *
 * `archive` is the one CORE capability whose declaration can flip on a HOST
 * fact. The terminal family's `archivable` — "this harness declares a handoff
 * transcript locator" — decides between `supported` and `unsupported`, and a
 * driver reaches exactly ONE of the two arms under its own `runConformance`
 * pass. Judging the other arm by a copy of these assertions is how the two
 * drift; judging it by this function is how they cannot. It is the same shape,
 * and the same argument, as `assertAttachHonoursOneControlLease` above.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BROKEN EXPORT LOOKS LIKE, WHICH IS WHY EACH ARM IS HERE
 * ---------------------------------------------------------------------------
 *
 * Nothing. That is the whole problem. An archive with no files, or with absolute
 * paths, or carrying the source machine's pid, or naming a different
 * conversation than the session it came from, is a WELL-FORMED OBJECT. It fails
 * on the destination machine, months later, at the moment somebody needs it —
 * which is the moment with the least tolerance for a driver bug. So every arm
 * below is stated against something the source machine can check for itself.
 *
 * REFUSE, DO NOT DEGRADE. `export()` returns `Promise<SessionArchive>` with no
 * refusal channel in its type, so an honest decline has two halves and they must
 * agree: the capability carries a `Declared` reason a human can act on, and the
 * verb REJECTS. A driver that declares no archive and then hands back an empty
 * one has told a caller their backup succeeded.
 */
export async function assertArchiveHonoursItsDeclaration(
  session: AgentSessionHandle,
  driver: Pick<RuntimeDriver, 'id' | 'harness' | 'family' | 'capabilities'>,
): Promise<void> {
  const declared = driver.capabilities().archive
  if (!declared.supported) {
    // The declaration IS the typed refusal; the throw is what enforces it.
    expect(declared.reason.length).toBeGreaterThan(0)
    await expect(
      session.export(),
      'this driver declares no archive, so export() must reject rather than return a hollow one',
    ).rejects.toThrow()
    return
  }

  /**
   * NO REF YET IS ALSO A REFUSAL, and it is the arm a driver reaches only when
   * its harness writes its store lazily. `SessionArchive.resume` is not
   * optional, and it is not decoration: an archive without it is bytes nobody
   * can resume from. Fabricating one — the session id, a path, anything to hand
   * — produces a backup that restores into a conversation that does not exist,
   * and the failure surfaces on the destination machine rather than here.
   */
  if (!session.binding.resume) {
    await expect(
      session.export(),
      'export() before a resume ref must reject: an archive that cannot be resumed is not an archive',
    ).rejects.toThrow()
    return
  }

  const archive = await session.export()

  // ---- it is the archive this driver said it produces -------------------
  // "Opaque-but-VERSIONED per harness: the importing side refuses a version it
  // does not speak rather than guessing at the layout." A version the capability
  // never declared is a layout nobody on the far side can refuse.
  expect(archive.formatVersion).toBe(declared.value.formatVersion)
  expect(archive.harness).toBe(driver.harness)
  expect(archive.binding.harness).toBe(driver.harness)
  expect(archive.binding.driver).toBe(driver.id)
  expect(archive.binding.family).toBe(driver.family)
  expect(archive.binding.sessionId).toBe(session.binding.sessionId)
  expect(archive.binding.workdir).toBe(session.binding.workdir)

  // ---- it names the conversation the session is ACTUALLY on -------------
  // The one field the destination machine resumes from. An archive whose ref
  // names a different conversation restores somebody else's work under this
  // session's name, and nothing downstream can detect it: both refs are
  // well-formed.
  if (session.binding.resume) expect(archive.resume).toEqual(session.binding.resume)
  expect(archive.binding.resume).toEqual(archive.resume)

  // ---- it carries the bytes its byte-faithful claim promises ------------
  if (declared.value.byteFaithful) {
    // BYTE-FAITHFUL IS A CLAIM ABOUT FILES, so an empty file list refutes it —
    // and this is a live failure mode rather than a hypothetical: the server
    // drivers build `files` from a host read that can answer `undefined`, and
    // the fallback is `[]`. That is an archive silently shipping zero bytes
    // while still declaring byte fidelity.
    expect(
      archive.files.length,
      'archive declares byteFaithful but shipped no files',
    ).toBeGreaterThan(0)
  }
  for (const file of archive.files) {
    expect(file.bytes.byteLength, `archive file ${file.path} is empty`).toBeGreaterThan(0)
  }

  // ---- it is MACHINE-INDEPENDENT ----------------------------------------
  for (const file of archive.files) {
    expect(file.path.length).toBeGreaterThan(0)
    // "Never absolute: an absolute path is a promise about the DESTINATION
    // machine that the source machine cannot make." Three drivers carry that
    // sentence as a comment and nothing checked it.
    expect(file.path.startsWith('/'), `${file.path} is absolute`).toBe(false)
    expect(file.path.startsWith('\\'), `${file.path} is absolute`).toBe(false)
    expect(/^[a-zA-Z]:[\\/]/.test(file.path), `${file.path} is absolute`).toBe(false)
    // An escape from the archive root is the same broken promise wearing a
    // relative path, and it writes outside the extraction directory.
    expect(file.path.split(/[\\/]/), `${file.path} escapes the archive root`).not.toContain('..')
  }

  /**
   * PROCESS IDENTITY IS PER-MACHINE, and the archive's type says so by omitting
   * it. The type alone does not enforce it: `Omit<>` rejects an excess property
   * in an object LITERAL, but a SPREAD of the live binding satisfies the
   * compiler while carrying the pid, the cgroup scope and the binding version
   * onto the destination machine — where they name a process that has never
   * existed there. Every driver builds this field by field today; this is what
   * keeps the cheaper spread from arriving later without anyone noticing.
   */
  expect(Object.hasOwn(archive.binding, 'process')).toBe(false)
  expect(Object.hasOwn(archive.binding, 'bindingVersion')).toBe(false)
}

/**
 * EXACTLY ONE CONTROL LEASE, AND UNLIMITED SPECTATORS (spec §5).
 *
 * Every step reads the lease back, because "refused" and "refused without
 * moving the lease" are different claims and only the second is the invariant:
 * a refusal that displaced the holder anyway would satisfy a check that looked
 * only at the return value.
 *
 * WHY THIS IS A FUNCTION AND NOT A PROPERTY BODY. It had already broken once,
 * in a driver, in the direction the type system cannot see: POD-2059 found
 * opencode's `attach` taking the lease UNCONDITIONALLY after starting a client,
 * so a second take-over silently displaced the first — while `lease.acquire()`,
 * one screen down in the same file, refused that exact case with `lease_held`.
 * One verb handing out for free what its sibling refuses is worse than neither
 * enforcing it, because callers read the refusal and believe it. Exported so
 * the teeth tests can build that driver and watch this refuse it — and so the
 * driver fixtures can reach the refusal assertions below on a host that has no
 * terminal to give, which their own `runConformance` pass never does.
 *
 * BOTH BRANCHES OF EVERY ANSWER ARE ASSERTED. A driver that DECLARES attach can
 * still refuse a particular call — the machine may have no terminal host to
 * spawn a client into — and the corpus said nothing about that: it assumed an
 * endpoint and would have died on `'kind' in endpoint` being false, which reads
 * in a run log as a broken test rather than as the branch it is. The refusal
 * side carries POD-2023's second invariant, expressed in something every target
 * can already observe: A REFUSED ATTACH MUST NOT BE HOLDING THE LEASE. Their old
 * code spawned the TUI and only then took it, so a refusal would have left an
 * orphaned terminal attached to a session it had just been refused control of.
 *
 * THE DRIVERS NO LONGER FIX THAT BY ORDERING, so neither does the failure text.
 * All three now RESERVE the lease before awaiting the host's client and ROLL IT
 * BACK when no client comes — deliberately, to close a race in which two
 * take-overs both won while the first was still starting (opencode's
 * `52781e293`, mirrored in the other two). "The refusal landed after the client
 * started" therefore names a sequence none of them still has; what this
 * assertion catches now is a reservation that was never rolled back, which is
 * the same orphaned controller by a different route.
 *
 * THAT ARM WAS DORMANT ON THE TARGETS THIS WAS WRITTEN AGAINST, and that was
 * sequencing rather than oversight: every fixture hosted a client, so no target
 * reached it, and the fixtures could only be changed once this property existed
 * to change them against. All three server-family fixtures have since been
 * given a host that refuses — opencode in POD-2121/POD-2131, codex-app-server
 * and grok-acp in POD-2486 — so both refusal assertions are now reached by a
 * REAL driver on every target that has one, and not only by the fake below.
 *
 * WHAT THE FAKE STILL BUYS, since the two now look alike from a distance: it
 * proves the ASSERTIONS bite, using a driver built to fail them. The driver
 * worlds prove the INVARIANT holds in the implementations that broke it.
 */
export async function assertAttachHonoursOneControlLease(
  session: AgentSessionHandle,
  capabilities: DriverCapabilities,
  family: DriverFamily,
): Promise<void> {
  const declared = capabilities.attach
  if (!declared.supported) {
    // THE DECLARED-GAP ARM, ASKED IN THE MODE THAT MATTERS. A family with no
    // terminal declines every mode, not just the one the older property happened
    // to ask for — an `attach` that refused `peek` and then handed out a
    // take-over endpoint would be a fabricated stream with a lease attached.
    expect(permits(family, 'no-attach')).toBe(true)
    expect(await session.attach({ mode: 'takeover', holder: 'operator' })).toMatchObject({
      reason: 'unsupported',
    })
    return
  }

  const answered = async (
    answer: Awaited<ReturnType<typeof session.attach>>,
  ): Promise<'endpoint' | 'refused'> => {
    if ('kind' in answer) {
      expect(declared.value.kinds).toContain(answer.kind)
      return 'endpoint'
    }
    /**
     * A TYPED refusal, never a bare shrug — the caller has to be able to branch
     * on why they did not get a terminal. The list is narrower than
     * `RefusalReason` because the type only proves the string is a MEMBER, and
     * the reasons a failed attach can honestly mean are a subset of the reasons
     * a failed SEND can.
     *
     * `busy` AND `needs_user` ARE ON IT DELIBERATELY (POD-2486). The list used
     * to stop at the three above, which made the codex driver's own refusals
     * illegal: it hands Codex's single writer to the native TUI only while the
     * session is IDLE, so a take-over during an open turn is `busy` and one
     * with an unanswered ask is `needs_user` (`drivers/codex/runtime.ts`). The
     * alternative was to normalize both to `unsupported` at the driver, and
     * that would be a lie in the direction that costs the caller most: they
     * mean "ask again in a moment" and "answer the prompt first", while
     * `unsupported` means "this will never work on this machine". Collapsing
     * them would defeat the very thing this line exists to assert, which is
     * that the caller can BRANCH on why.
     *
     * The two left off are left off on purpose: `no_resume_ref` is
     * `hibernate`'s alone, and `session_ended` is not an attach answer any
     * driver gives — a session that ended has no endpoint and no lease, and a
     * driver reaching for it should have to come here and say why.
     */
    expect(['unsupported', 'not_running', 'lease_held', 'busy', 'needs_user']).toContain(
      answer.reason,
    )
    return 'refused'
  }

  // A SPECTATOR TAKES NOTHING. There is no spectator arm in `lease` at all —
  // that is the design — so the observable is that the lease is exactly as it
  // was.
  const before = await session.lease.state()
  const peeked = await answered(await session.attach({ mode: 'peek', holder: 'viewer' }))
  expect(await session.lease.state(), 'a peek took the control lease').toEqual(before)
  if (peeked === 'refused') {
    // This machine cannot host a terminal for this session. Nothing below is
    // reachable, and pretending otherwise would test the fixture, not the driver.
    return
  }

  // A CONTROLLER TAKES IT, and the lease says who by. Reading it through
  // `lease.state()` rather than trusting the endpoint is the point: the two
  // verbs must agree, and this is where they are compared.
  const took = await answered(await session.attach({ mode: 'takeover', holder: 'operator' }))
  if (took === 'refused') {
    expect(
      await session.lease.state(),
      'a refused take-over kept the control lease — the reservation was never rolled back',
    ).toEqual(before)
    return
  }
  /**
   * THE KIND, NOT ONLY THE HOLDER, because the kind is what `send` branches on.
   *
   * This read used to check `holder` alone, and a driver-level test in the
   * opencode family was the only thing pinning that `attach({mode:'takeover'})`
   * produces a HUMAN-controller lease. When POD-2121 removed that test as
   * duplicated, the kind went unpinned for every family — mutation-proven: flip
   * the attach path to `'driver-controller'` and the whole suite stays green,
   * while a steward's nudge then reaches the agent with a human at the TUI.
   * That is the §5 interleaving POD-2059 existed to stop.
   *
   * `lease.acquire` is NOT a substitute: the steward-exclusion property above
   * establishes its lease through `acquire`, so the ATTACH path's kind is only
   * ever observed here.
   */
  expect(await session.lease.state()).toMatchObject({
    holder: 'operator',
    kind: 'human-controller',
  })

  // A SECOND CONTROLLER IS REFUSED — and the lease DOES NOT MOVE.
  expect(await session.attach({ mode: 'takeover', holder: 'intruder' })).toMatchObject({
    reason: 'lease_held',
  })
  expect(
    await session.lease.state(),
    'a refused take-over displaced the holder anyway',
  ).toMatchObject({ holder: 'operator' })

  // THE HOLDER MAY COME BACK. A dropped TUI reconnecting is the ordinary case,
  // and a driver that locked the holder out with its own lease would strand the
  // one person entitled to be there — which is why the guard is "a DIFFERENT
  // holder", not "a lease exists".
  expect('kind' in (await session.attach({ mode: 'takeover', holder: 'operator' }))).toBe(true)
  expect(await session.lease.state()).toMatchObject({ holder: 'operator' })

  // AND SPECTATORS ARE STILL UNLIMITED while somebody holds control: the
  // exclusion is on the control lease, never on watching.
  expect('kind' in (await session.attach({ mode: 'peek', holder: 'second-viewer' }))).toBe(true)
  expect(await session.lease.state()).toMatchObject({ holder: 'operator' })
}

/**
 * What a `deliveredAs: 'steer'` receipt has to be TRUE about.
 *
 * THREE READINGS AT RECEIPT TIME, and one after the turn fences:
 *
 *   1. the receipt names the OPEN turn — it joined a turn, it did not open one;
 *   2. the session is still on that turn — nothing was opened during the send
 *      behind an honest-looking epoch in the receipt;
 *   3. EXACTLY ONE more delivery of the caller's text has reached the agent.
 *      Words in a queue have not reached anybody, and `textDeliveries` counts at
 *      the drain (see `./target.ts`), so a driver that queued while reporting a
 *      steer reads as zero here;
 *   4. and after the fence, THE COUNT DOES NOT RISE AGAIN.
 *
 * WHY 4 IS NOT REDUNDANT, and the honest limit of 3 (POD-2085 review round 2,
 * finding 1). Reading 3's guarantee holds only for a target that follows rule 3
 * of the counting contract, and nothing here can check that a target counts
 * where it says it does. The reviewer built the gap: a fake made devious on the
 * steer branch — queue the words AND increment — satisfies all three readings
 * and passes, because the count moved at the wrong MOMENT rather than by the
 * wrong AMOUNT. Fencing the turn is what separates the two: a steer's words were
 * already in that turn, so nothing may be delivered on its way out, while the
 * devious construction's queue drains there and reads `before + 2`.
 *
 * The earlier comment claimed reading 3 was something "an impostor cannot fake
 * while queueing" and that a queue "reads as zero no matter how fast it drains
 * afterwards". Both were overclaims, on the one property whose entire job is to
 * be stronger than its comment.
 *
 * WHAT 4 DOES NOT CATCH, stated rather than implied: a target whose second
 * delivery lands later than this reading. That is a timing gap and it is the
 * price of not reintroducing a sleep — reading 3 is the race-free half, and
 * everything above is what a driver can be held to without one.
 *
 * EQUALITY, NOT `<=`, on the epochs (review round 1, finding 4). An epoch that
 * went BACKWARDS after a fence is a different contract violation, and a bound
 * that licenses it is not stating the invariant it claims to.
 *
 * Exported so the corpus's own teeth test can drive it with
 * `createFakeServerDriver({ steerImpostor: true })` and watch it refuse — the
 * same reason {@link assertUnverifiedClaimHonest} is exported, and the gap
 * review finding 3 named: an assertion whose only caller is its own property
 * cannot be shown to bite.
 */
export function assertSteerJoinedOpenTurn(observed: {
  receipt: TurnReceipt
  openEpoch: number
  epochAfterReceipt: number
  textDeliveries: { before: number; afterReceipt: number; afterFence: number }
}): void {
  const { receipt, openEpoch, epochAfterReceipt, textDeliveries } = observed
  expect(receipt.outcome).toBe('accepted')
  if (receipt.outcome !== 'accepted') return
  expect(receipt.turnEpoch, 'a steer receipt names a turn it did not join').toBe(openEpoch)
  expect(
    epochAfterReceipt,
    'a steer opened a turn of its own — that is a new turn wearing the steer label',
  ).toBe(openEpoch)
  expect(
    textDeliveries.afterReceipt,
    'the receipt says the words joined the open turn, but nothing reached the agent — they are sitting in a queue',
  ).toBe(textDeliveries.before + 1)
  expect(
    textDeliveries.afterFence,
    'a steer was delivered a SECOND time when the turn fenced — its words were queued behind the turn they claimed to join',
  ).toBe(textDeliveries.before + 1)
}

/**
 * A driver may decline native `steer` only if it is on the pinned list.
 *
 * BOTH GATES, AND THE SECOND IS THE ONE WITH TEETH. The family row is checked
 * first because a family that was never granted the weakness must not exhibit it
 * at all — but that row is now on all three families, so on its own it is a
 * tautology. The pin in `NO_NATIVE_STEER_DRIVERS` is what a new driver has to
 * pass through: steering is a per-HARNESS protocol verb, so "does this harness
 * have one?" has exactly one honest answer per driver and somebody has to have
 * looked. A codex-server that quietly omitted `steer` from `send.native` fails
 * here, which is the whole point — its app-server HAS `turn/steer`.
 *
 * Exported so the corpus's own negative tests can drive it with an unlisted
 * driver id and watch it refuse: an assertion nobody has watched fail is a
 * comment.
 */
export function assertNoNativeSteerEntitled(family: DriverFamily, driverId: DriverId): void {
  expect(
    permits(family, 'no-native-steer'),
    `family '${family}' is not permitted to decline native steer`,
  ).toBe(true)
  expect(
    permitsNoNativeSteer(driverId),
    `driver '${driverId}' declined native steer without being on the entitled list (${NO_NATIVE_STEER_DRIVERS.join(', ')}) — steering is a per-harness protocol verb, so add it there WITH the measurement or declare 'steer' native`,
  ).toBe(true)
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
