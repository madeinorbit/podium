/**
 * THE IN-MEMORY REFERENCE DRIVER (POD-1761 W1).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * The conformance corpus is worthless if the first thing it ever runs against is
 * a real driver: a red suite would be ambiguous between "the driver is wrong" and
 * "the suite is wrong". So the corpus runs green against THIS first — an honest,
 * complete, in-memory implementation of the contract with no process, no socket
 * and no harness behind it.
 *
 * It is NOT a mock. Mocks assert on calls; this one implements SEMANTICS —
 * turn epochs advance, cursors are monotonic, fences are absorbing, leases
 * exclude, interactions are idempotent, and a "supervisor restart" genuinely
 * loses the handle while the binding survives. When W3 and W5 run the same
 * corpus, any disagreement is about their driver, not about what the corpus
 * means.
 *
 * TWO PERSONALITIES, because one is not enough to test the permitted-failures
 * table: {@link createFakeServerDriver} declares the strong guarantees a server
 * family must meet, and {@link createFakeTerminalDriver} declares the weaknesses
 * the terminal family is allowed to have (unverified sends, at-least-once
 * classifier interactions, no native steer). A corpus that only ever saw the
 * strong one would prove nothing about the hardest driver.
 */

import { supported, unsupported } from '@podium/harness'
import type { AgentRuntimeState, ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import type {
  AgentSessionHandle,
  AttachEndpoint,
  AttachmentRef,
  AttachRequest,
  CausalEnvelope,
  ConfigureRequest,
  DriverCapabilities,
  DriverFamily,
  DriverId,
  EventStreamStart,
  FailureDisposition,
  InteractionAnswerOutcome,
  InteractionKind,
  InteractionSource,
  PendingInteraction,
  ProcessEvent,
  Refusal,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeEventBody,
  SendOptions,
  SessionArchive,
  SessionBinding,
  SessionHealth,
  SessionLease,
  SessionSnapshot,
  SessionSpec,
  TurnDelivery,
  TurnEvent,
  TurnFailureReason,
  TurnInput,
  TurnReceipt,
  UsageSnapshot,
  WatchLevel,
} from '../index.js'

// ---------------------------------------------------------------------------
// The surviving-process registry — what makes `adopt()` testable
// ---------------------------------------------------------------------------

/**
 * Sessions that "survive" a supervisor restart, keyed by process identity.
 *
 * This is the fake's stand-in for abduco masters and harness server processes:
 * dropping a driver instance drops the HANDLES, exactly as a daemon restart
 * does, while the entries here stay put so `adopt()` has something real to find.
 * Without it, a restart test would be adopting an object it never let go of.
 */
const SURVIVORS = new Map<string, SessionCore>()

/** Clears the survivor registry. Test-support only: a suite that leaks a
 *  survivor into the next case gets a passing adopt it did not earn. */
export function resetFakeRuntime(): void {
  SURVIVORS.clear()
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FakeDriverOptions {
  id?: DriverId
  family?: DriverFamily
  harness?: string
  /** Deliveries this fake implements NATIVELY. Anything else degrades and the
   *  receipt reports it. */
  nativeDeliveries?: readonly TurnDelivery[]
  /** TERMINAL FAMILY ONLY — the suite asserts a server/embedded fake never sets
   *  this, because claiming a weakness you do not have is as dishonest as hiding
   *  one you do. */
  mayReturnUnverified?: boolean
  interactionSource?: InteractionSource
  /** `true` for classifier-sourced asks: identity is best-effort and
   *  asked→answered is at-least-once. */
  atLeastOnceInteractions?: boolean
  /** Server-family fakes hold a per-session secret; connecting without it must
   *  be refused (spec §6). */
  requiresConnectSecret?: boolean
  /**
   * DELIBERATELY DISHONEST — the impostor the anti-substitution property exists
   * to catch, kept in the tree rather than rebuilt by hand.
   *
   * Reports `deliveredAs: 'steer'` with the OPEN turn's epoch, and queues the
   * words. Every receipt field is well-formed; the only thing wrong is that
   * nothing reached the agent. POD-2085's first round watched this fail once
   * and threw the patch away, which left the property's own teeth living in a
   * commit message (review finding 3) — a check nothing in the tree would
   * notice weakening.
   */
  steerImpostor?: boolean
}

/**
 * The out-of-band control surface the corpus needs. Some states have no contract
 * verb that reaches them — a provider cannot be made to fail a turn from the
 * outside, and a process cannot be made to OOM — so a driver under test supplies
 * them here. Real drivers implement this against their own harness (W3 drives a
 * genuine permission prompt; W5 posts a real `permission.updated`).
 */
export interface FakeControl {
  /** Open a blocking ask, as a provider would. `spec` is the kind paired with
   *  its OWN payload (POD-2020 made that pairing typed); pass a bare kind and
   *  the fake fills in {@link defaultAskFor}'s minimal payload for it. */
  askInteraction(sessionId: SessionId, spec: InteractionKind | InteractionAskSpec): string
  /** Re-ask the SAME logical interaction with a fresh id — the duplicate a
   *  re-rendered menu mints. Only meaningful when `atLeastOnceInteractions`. */
  reaskInteraction(sessionId: SessionId, id: string): string
  /** Make the provider fail the open turn. */
  failTurn(sessionId: SessionId, reason: InducibleFailure): void
  /** Confirm the open turn as finished — the provider confirmation that turns a
   *  requested fence into an emitted one. */
  completeTurn(sessionId: SessionId): void
  /** Emit a process event. */
  processEvent(sessionId: SessionId, ev: ProcessEvent): void
  /** The next `send` cannot prove acceptance inside its window. Refused unless
   *  the driver declared `mayReturnUnverified`. */
  failNextVerification(sessionId: SessionId): void
  /** How many times this session's text has reached the agent — see
   *  `ConformanceControl.textDeliveries` for the four counting rules. */
  textDeliveries(sessionId: SessionId): number
  /** Simulate a supervisor restart: every handle is dropped, the survivor
   *  registry is not. */
  restartSupervisor(): void
  /** Server family only: attempt a connection without the per-session secret.
   *  Must refuse. */
  connectWithoutSecret(sessionId: SessionId): { refused: true } | { refused: false }
  /** Append a transcript item, as a harness writing its native store would. */
  emitItem(sessionId: SessionId, item: TranscriptItem): void
}

export interface FakeDriver extends RuntimeDriver {
  readonly control: FakeControl
}

// ---------------------------------------------------------------------------
// Session core — the state a "surviving process" owns
// ---------------------------------------------------------------------------

interface LoggedEvent {
  seq: number
  event: RuntimeEvent
}

interface SessionCore {
  sessionId: SessionId
  spec: SessionSpec
  binding: SessionBinding
  /** Monotonic, never reset — this is what makes a cursor comparable across an
   *  adopt. Resetting it on restart is the classic way to replay a stream as if
   *  it were new. */
  seq: number
  turnEpoch: number
  /** Open turn, or null. A turn epoch is closed by a terminal event and never
   *  reopens — fences are absorbing. */
  turnOpen: boolean
  /** Epochs that reached a terminal event. Re-closing one is a no-op, which is
   *  what "absorbing" means operationally. */
  fenced: Set<number>
  observerGeneration: number
  state: AgentRuntimeState
  log: LoggedEvent[]
  /** Live consumers, woken when the log grows. */
  wakers: Set<() => void>
  interactions: Map<string, PendingInteraction>
  answered: Set<string>
  expired: Set<string>
  queue: string[]
  lease: SessionLease | null
  draft: string
  items: TranscriptItem[]
  alive: boolean
  oomEvents: number
  failNextVerification: boolean
  /** Times the caller's text reached the agent, counted so the corpus can prove
   *  directly that an unprovable send is not re-delivered — and that a queued
   *  one is not delivered until it drains. */
  textDeliveries: number
  /** Only ever read by `connectWithoutSecret`. Never in argv, never logged —
   *  the fake keeps the discipline the real one must (spec §6). */
  connectSecret: string | null
  watchers: Map<WatchLevel, number>
  usage: UsageSnapshot
  interruptRequested: boolean
  /** Bumped on every simulated supervisor restart. A handle minted before the
   *  bump is stale and refuses — see `restartSupervisor`. */
  handleGeneration: number
  nextId: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic clock. `Date.now()` in a conformance fake makes a timing-
 *  sensitive assertion flaky for reasons that have nothing to do with the
 *  contract, so time advances one tick per stamped event. */
let clockTick = 0
const stamp = (): string => new Date(Date.UTC(2026, 0, 1) + clockTick++ * 1000).toISOString()

const cursorAt = (core: SessionCore, seq: number): ProviderCursor => ({
  segmentId: core.binding.process.key,
  components: { seq },
})

/** The failure reasons the fake can be driven into. `interrupted` is absent on
 *  purpose: it is produced by `interrupt()` + provider confirmation, not induced. */
export type InducibleFailure = Exclude<TurnFailureReason, 'interrupted'>

export function dispositionFor(reason: InducibleFailure): FailureDisposition {
  switch (reason) {
    case 'rate-limit':
    case 'timeout':
      return 'retryable'
    // ONE ROUTING RULE: `needs-human` failures materialize as PendingInteractions
    // — auth-expired becomes a `login` ask, context-overflow a `recovery` one.
    // That is what keeps a failed session enumerable instead of stuck.
    case 'auth-expired':
    case 'context-overflow':
      return 'needs-human'
    case 'provider-error':
      return 'fatal'
  }
}

const INTERACTION_FOR_FAILURE: Partial<Record<InducibleFailure, InteractionKind>> = {
  'auth-expired': 'login',
  'context-overflow': 'recovery',
}

/** A kind paired with the payload THAT kind takes — the ask half of
 *  {@link PendingInteraction}, without the identity the driver mints.
 *
 *  Distributive on purpose: a plain `Pick<PendingInteraction, 'kind'|'payload'>`
 *  collapses the union into `{kind: InteractionKind; payload: AnyPayload}`,
 *  which would let a `login` kind carry a `question` payload — exactly the
 *  pairing the discriminated union exists to make unrepresentable. */
type AskSpecOf<T> = T extends { kind: infer K; payload: infer P }
  ? { readonly kind: K; readonly payload: P }
  : never
export type InteractionAskSpec = AskSpecOf<PendingInteraction>

/**
 * The smallest VALID payload for each kind.
 *
 * Exists because the corpus mostly cares that an ask opened and closed, not what
 * it said — but "not what it said" stopped being expressible as `{}` when
 * POD-2020 typed the payloads, and that is the point: a test that wants a
 * specific shape now has to name it. These are minimal and deliberately boring,
 * so a corpus case asserting on payload content is obviously doing so on
 * purpose.
 */
/** The `recovery` ask a context-overflow raises, as distinct from the
 *  cache-miss one {@link defaultAskFor} mints. */
const askPayloadForOverflow = () =>
  ({
    v: 1,
    reason: 'context-overflow',
    prompt: 'The context window overflowed. How should this session continue?',
    offered: ['full-resume', 'summary-resume', 'fresh-session', 'abandon'],
  }) as const

export function defaultAskFor(kind: InteractionKind): InteractionAskSpec {
  switch (kind) {
    case 'permission':
      return { kind, payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false } }
    case 'question':
      return {
        kind,
        payload: {
          v: 1,
          questions: [
            {
              question: 'Which way?',
              multiSelect: false,
              previewLayout: false,
              options: [{ label: 'Left' }, { label: 'Right' }],
            },
          ],
        },
      }
    case 'plan-approval':
      return { kind, payload: { v: 1, plan: 'Do the thing.', autoAcceptOffered: false } }
    case 'elicitation':
      return {
        kind,
        payload: { v: 1, message: 'Fill this in.', requestedSchema: { type: 'object' } },
      }
    case 'login':
      return { kind, payload: { v: 1, provider: 'fake', reason: 'auth-expired' } }
    case 'recovery':
      return {
        kind,
        payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
      }
  }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export function createFakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  const family: DriverFamily = options.family ?? 'server'
  const id: DriverId = options.id ?? 'fake'
  const harness = options.harness ?? 'fake-harness'
  const nativeDeliveries = options.nativeDeliveries ?? ['when-ready', 'queue', 'interrupt', 'steer']
  const mayReturnUnverified = options.mayReturnUnverified ?? false
  const interactionSource: InteractionSource = options.interactionSource ?? 'protocol'
  const atLeastOnce = options.atLeastOnceInteractions ?? false
  const requiresConnectSecret = options.requiresConnectSecret ?? family === 'server'
  const steerImpostor = options.steerImpostor ?? false

  const capabilities = (): DriverCapabilities => ({
    send: {
      native: nativeDeliveries,
      proof: family === 'terminal' ? ['hook', 'transcript-echo'] : ['protocol-ack'],
      mayReturnUnverified,
      verificationWindowMs: mayReturnUnverified ? 1600 : undefined,
    },
    interrupt: { fenceOnProviderConfirmation: true },
    interactions: supported({
      kinds: ['permission', 'question', 'plan-approval', 'elicitation', 'login', 'recovery'],
      source: interactionSource,
      answerable: family === 'terminal' ? 'keystroke-emulated' : 'structured',
      atLeastOnce,
    }),
    observation: {
      watchLevels: ['coarse', 'fine'],
      cursorMaterial: 'in-memory-seq',
    },
    transcript: supported({ history: true }),
    attach:
      family === 'embedded'
        ? unsupported('the embedded family hosts the loop in a worker; there is no terminal')
        : supported({ kinds: family === 'terminal' ? ['engine'] : ['client'] }),
    lease: supported({ humanTakeover: true }),
    snapshot: supported({ includesDraft: true }),
    archive: supported({ formatVersion: 1, byteFaithful: true }),
    resumeRefTiming: 'spawn',
    placement: 'dedicated',
    draft: supported({ read: true, write: true }),
    configure: supported({ fields: ['model', 'effort', 'permissionMode'] }),
    usage: supported({ perTurn: true }),
    openUrl: supported({ intents: ['login', 'link'] }),
    title: supported({ source: 'synthetic' }),
    accentColor: supported(true),
  })

  // -- event plumbing -------------------------------------------------------

  function push(
    core: SessionCore,
    event: RuntimeEventBody,
    provenance: CausalEnvelope['provenance'] = 'live',
  ): void {
    core.seq += 1
    core.log.push({
      seq: core.seq,
      event: {
        ...event,
        at: stamp(),
        provenance,
        cursor: cursorAt(core, core.seq),
        observerGeneration: core.observerGeneration,
        turnEpoch: core.turnEpoch,
      },
    })
    for (const wake of [...core.wakers]) wake()
  }

  function openTurn(core: SessionCore, origin: SendOptions['origin']): number {
    core.turnEpoch += 1
    core.turnOpen = true
    core.state = { ...core.state, phase: 'working', since: stamp() }
    push(core, { t: 'turn', ev: { ev: 'started', turnEpoch: core.turnEpoch, origin } })
    return core.turnEpoch
  }

  function closeTurn(core: SessionCore, ev: TurnEvent): void {
    // ABSORBING: a second terminal event for an epoch already fenced changes
    // nothing. This is the invariant that stops a late provider message from
    // reopening a turn the observer already closed.
    if (core.fenced.has(ev.turnEpoch)) return
    core.fenced.add(ev.turnEpoch)
    core.turnOpen = false
    push(core, { t: 'turn', ev })
    core.state = {
      ...core.state,
      phase: ev.ev === 'failed' ? 'errored' : 'idle',
      since: stamp(),
    }
    push(core, {
      t: 'state',
      change:
        ev.ev === 'failed'
          ? {
              kind: 'turn_failed',
              errorClass: ev.reason,
              retryable: ev.disposition === 'retryable',
            }
          : { kind: 'turn_completed' },
    })
    // Drain one queued send into the next turn, so `queued` is a real promise
    // rather than a receipt shape nothing honours.
    if (core.queue.length > 0) {
      core.queue.shift()
      // Rule 3, the other end of it: THIS is where a queued turn's words reach
      // the agent. Counting at `send()` instead made "the queue drained" true
      // before the drain, which is the defect that let a queue that silently
      // dropped its words pass the whole corpus (POD-2085 review, finding 1).
      core.textDeliveries += 1
      openTurn(core, 'system')
    }
  }

  function ask(core: SessionCore, spec: InteractionAskSpec, source: InteractionSource): string {
    const interactionId = `int-${core.sessionId}-${core.nextId++}`
    const interaction: PendingInteraction = {
      ...spec,
      id: interactionId,
      sessionId: core.sessionId,
      askedAt: stamp(),
      source,
      answerable: family === 'terminal' ? 'keystroke-emulated' : 'structured',
    }
    core.interactions.set(interactionId, interaction)
    core.state = { ...core.state, phase: 'needs_user', since: stamp() }
    push(core, { t: 'interaction', ev: { ev: 'asked', interaction } })
    return interactionId
  }

  // -- handle ---------------------------------------------------------------

  function makeHandle(core: SessionCore): AgentSessionHandle {
    const refuse = (reason: Refusal['reason'], detail?: string): Refusal => ({ reason, detail })
    // The generation this handle was minted at. A supervisor restart invalidates
    // it, so holding a stale handle across one is an error the fake REPORTS
    // rather than tolerates.
    const mintedAt = core.handleGeneration
    const assertLive = (): void => {
      if (core.handleGeneration !== mintedAt) {
        throw new Error(
          'fake: this handle was minted before a supervisor restart — adopt() the binding to get a live one',
        )
      }
    }

    const handle: AgentSessionHandle = {
      get binding() {
        return core.binding
      },

      // ---- lifecycle ----
      async stop() {
        core.alive = false
        push(core, {
          t: 'process',
          ev: { ev: 'exited', code: 0, signal: null, classification: 'clean' },
        })
        SURVIVORS.delete(core.binding.process.key)
      },

      async hibernate() {
        // REFUSES WITHOUT A RESUME REF. Hibernating a session we cannot bring
        // back is data loss wearing a lifecycle verb's name.
        if (!core.binding.resume) return refuse('no_resume_ref')
        core.alive = false
        return { ok: true as const }
      },

      async kill() {
        core.alive = false
        push(core, {
          t: 'process',
          ev: { ev: 'exited', code: null, signal: 'SIGKILL', classification: 'killed' },
        })
        SURVIVORS.delete(core.binding.process.key)
      },

      async health(): Promise<SessionHealth> {
        return {
          alive: core.alive,
          memoryBytes: 64 * 1024 * 1024,
          scopeUnit: core.binding.process.scopeUnit,
          oomEvents: core.oomEvents,
        }
      },

      // ---- identity ----
      async snapshot(): Promise<SessionSnapshot> {
        assertLive()
        return {
          binding: core.binding,
          state: core.state,
          cursor: cursorAt(core, core.seq),
          observerGeneration: core.observerGeneration,
          turnEpoch: core.turnEpoch,
          interactions: [...core.interactions.values()],
          draft: core.draft,
          at: stamp(),
        }
      },

      async export(): Promise<SessionArchive> {
        if (!core.binding.resume) throw new Error('fake: export before a resume ref exists')
        return {
          harness,
          formatVersion: 1,
          resume: core.binding.resume,
          files: [
            {
              path: `${core.sessionId}.jsonl`,
              bytes: new TextEncoder().encode(
                core.items.map((item) => JSON.stringify(item)).join('\n'),
              ),
            },
          ],
          binding: {
            sessionId: core.binding.sessionId,
            driver: core.binding.driver,
            family: core.binding.family,
            harness: core.binding.harness,
            workdir: core.binding.workdir,
            resume: core.binding.resume,
            principal: core.binding.principal,
          },
        }
      },

      // ---- turns ----
      async send(_input: TurnInput, options: SendOptions): Promise<TurnReceipt> {
        assertLive()
        if (!core.alive) return { outcome: 'refused', refusal: refuse('not_running') }
        if (core.interactions.size > 0) {
          return {
            outcome: 'refused',
            refusal: refuse('needs_user', `${core.interactions.size} open interaction(s)`),
          }
        }
        // A human holding take-over serializes ALL controller writes behind
        // them; headless drivers queue rather than interleave.
        if (core.lease?.kind === 'human-controller' && options.origin !== 'human') {
          return { outcome: 'refused', refusal: refuse('lease_held', core.lease.holder) }
        }

        // DELIVERY DEGRADATION IS REPORTED, NEVER SILENT.
        const requested = options.delivery
        const deliveredAs: TurnDelivery = nativeDeliveries.includes(requested)
          ? requested
          : requested === 'steer'
            ? 'queue'
            : 'when-ready'

        /**
         * COUNTED WHERE THE WORDS LEAVE, ONCE PER BRANCH THAT SENDS THEM.
         *
         * This used to be a single increment above, past the refusals, on the
         * argument that "the caller's words were handed over" is decided there.
         * It is not: the QUEUE branch below hands nothing over — it parks the
         * words — so the count ran ahead of the delivery and every assertion
         * about a drain was already true before the drain (POD-2085 review,
         * finding 1). `ConformanceControl.textDeliveries` states the four rules;
         * this is the reference implementation of them, so each branch counts
         * for itself and the queue counts at `closeTurn`'s drain instead.
         */
        if (core.failNextVerification) {
          core.failNextVerification = false
          if (!mayReturnUnverified) {
            throw new Error(
              'fake: verification failure requested on a driver that declared it cannot happen',
            )
          }
          // Rule 1: the keystrokes went out, only the proof did not come back.
          core.textDeliveries += 1
          return {
            outcome: 'unverified',
            deliveredAs,
            verificationWindowMs: capabilities().send.verificationWindowMs ?? 1600,
            at: stamp(),
          }
        }

        if (deliveredAs === 'interrupt') {
          if (core.turnOpen) {
            closeTurn(core, { ev: 'completed', turnEpoch: core.turnEpoch, verdict: 'interrupted' })
          }
          core.textDeliveries += 1
          return {
            outcome: 'accepted',
            turnEpoch: openTurn(core, options.origin),
            deliveredAs,
            provenBy: capabilities().send.proof[0] ?? 'protocol-ack',
            at: stamp(),
          }
        }

        if (deliveredAs === 'steer' && core.turnOpen) {
          // Appends into the OPEN turn: the epoch does not advance, which is
          // exactly what distinguishes steer from a new turn. Rule 2 — the
          // delivery is REAL even though no turn opened, and a counter watching
          // turn starts would report nothing here (POD-2024 measured exactly
          // that against their codex fixture).
          if (steerImpostor) core.queue.push(stamp())
          else core.textDeliveries += 1
          return {
            outcome: 'accepted',
            turnEpoch: core.turnEpoch,
            deliveredAs,
            provenBy: capabilities().send.proof[0] ?? 'protocol-ack',
            at: stamp(),
          }
        }

        if (deliveredAs === 'queue' || core.turnOpen) {
          // Rule 3: NOT counted here. The words are parked, and `queued` is the
          // receipt that says so.
          core.queue.push(stamp())
          return {
            outcome: 'queued',
            position: core.queue.length,
            deliveredAs: 'queue',
            at: stamp(),
          }
        }

        core.textDeliveries += 1
        return {
          outcome: 'accepted',
          turnEpoch: openTurn(core, options.origin),
          deliveredAs,
          provenBy: capabilities().send.proof[0] ?? 'protocol-ack',
          at: stamp(),
        }
      },

      async stageAttachment(source): Promise<AttachmentRef> {
        return {
          id: `att-${core.nextId++}`,
          path: `${core.spec.workdir}/.podium/attachments/${source.filename}`,
        }
      },

      async interrupt(): Promise<void> {
        // REQUESTS a fence. The fence lands only when the provider confirms —
        // `control.completeTurn` is the fake's provider. Nothing is emitted here.
        core.interruptRequested = true
      },

      async answer(interactionId, _answer): Promise<InteractionAnswerOutcome> {
        if (core.expired.has(interactionId)) return { ok: false, reason: 'expired' }
        // IDEMPOTENT: answering twice is a typed error, not a double action.
        if (core.answered.has(interactionId)) return { ok: false, reason: 'already-answered' }
        const interaction = core.interactions.get(interactionId)
        if (!interaction) return { ok: false, reason: 'unknown-interaction' }
        core.interactions.delete(interactionId)
        core.answered.add(interactionId)
        push(core, {
          t: 'interaction',
          ev: { ev: 'answered', id: interactionId, answeredBy: 'human', at: stamp() },
        })
        if (core.interactions.size === 0) {
          core.state = { ...core.state, phase: core.turnOpen ? 'working' : 'idle', since: stamp() }
        }
        return { ok: true }
      },

      async interactions() {
        return [...core.interactions.values()]
      },

      // ---- observation ----
      events(after: EventStreamStart): AsyncIterable<RuntimeEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            // BOOTSTRAP vs LIVE is a provenance fact, not a delivery detail: a
            // replayed event must never carry live effects, which is why the
            // envelope says which it is rather than the consumer guessing.
            let position = after === 'bootstrap' ? 0 : Number(after.components.seq ?? 0)
            const bootstrapUntil = after === 'bootstrap' ? core.seq : position
            while (true) {
              while (position < core.log.length) {
                const entry = core.log[position]
                position += 1
                if (!entry) continue
                yield {
                  ...entry.event,
                  provenance: entry.seq <= bootstrapUntil ? 'bootstrap' : entry.event.provenance,
                } as RuntimeEvent
              }
              if (!core.alive) return
              await new Promise<void>((resolve) => {
                const waker = () => {
                  core.wakers.delete(waker)
                  resolve()
                }
                core.wakers.add(waker)
              })
            }
          },
        }
      },

      async watch(level: WatchLevel) {
        core.watchers.set(level, (core.watchers.get(level) ?? 0) + 1)
        let released = false
        // REFCOUNTED, and the release is idempotent: a viewer that disconnects
        // twice must not drop somebody else's watch.
        return () => {
          if (released) return
          released = true
          core.watchers.set(level, Math.max(0, (core.watchers.get(level) ?? 1) - 1))
        }
      },

      async state() {
        return core.state
      },

      transcript: {
        async history({ limit }) {
          return core.items.slice(-limit)
        },
      },

      // ---- attach & lease ----
      async attach(req: AttachRequest): Promise<AttachEndpoint | Refusal> {
        const declared = capabilities().attach
        if (!declared.supported) return refuse('unsupported', declared.reason)
        if (req.mode === 'takeover' && core.lease && core.lease.holder !== req.holder) {
          return refuse('lease_held', core.lease.holder)
        }
        if (req.mode === 'takeover') {
          core.lease = {
            holder: req.holder,
            kind: 'human-controller',
            acquiredAt: stamp(),
          }
        }
        return family === 'terminal'
          ? { kind: 'engine', stream: { id: `frames-${core.sessionId}` } }
          : {
              kind: 'client',
              placement: 'on-machine',
              stream: { id: `frames-${core.sessionId}` },
              warm: { ttlMs: 300_000 },
            }
      },

      lease: {
        async acquire(holder, kind) {
          // EXACTLY ONE controller. Spectators do not take a lease at all, which
          // is why there is no spectator arm here.
          if (core.lease && core.lease.holder !== holder) {
            return refuse('lease_held', core.lease.holder)
          }
          core.lease = { holder, kind, acquiredAt: stamp() }
          return core.lease
        },
        async release(holder) {
          if (core.lease?.holder === holder) core.lease = null
        },
        async state() {
          return core.lease
        },
      },

      // ---- extended ----
      draft: {
        async get() {
          return core.draft
        },
        async set(text) {
          core.draft = text
          return { ok: true as const }
        },
      },

      async configure(request: ConfigureRequest) {
        const declared = capabilities().configure
        if (!declared.supported) return refuse('unsupported', declared.reason)
        // STICKY for the session — per-turn overrides ride TurnInput instead.
        if (request.model)
          core.spec = { ...core.spec, model: { ...core.spec.model, model: request.model } }
        if (request.effort)
          core.spec = { ...core.spec, model: { ...core.spec.model, effort: request.effort } }
        return { ok: true as const }
      },

      async usage() {
        return core.usage
      },
    }

    return handle
  }

  // -- core construction ----------------------------------------------------

  function newCore(sessionId: SessionId, spec: SessionSpec, resume: ResumeRef | null): SessionCore {
    const processKey = `fake-proc-${sessionId}`
    const core: SessionCore = {
      sessionId,
      spec,
      binding: {
        sessionId,
        driver: id,
        family,
        harness,
        workdir: spec.workdir,
        resume,
        principal: spec.principal,
        process: { key: processKey, scopeUnit: `podium-fake-sess-${sessionId}.scope`, pid: 4242 },
        bindingVersion: 1,
      },
      seq: 0,
      turnEpoch: 0,
      turnOpen: false,
      fenced: new Set(),
      observerGeneration: 1,
      state: { phase: 'unknown', since: stamp(), nativeSubagentCount: 0 },
      log: [],
      wakers: new Set(),
      interactions: new Map(),
      answered: new Set(),
      expired: new Set(),
      queue: [],
      lease: null,
      draft: '',
      items: [],
      alive: true,
      oomEvents: 0,
      failNextVerification: false,
      textDeliveries: 0,
      connectSecret: requiresConnectSecret ? `secret-${sessionId}` : null,
      watchers: new Map(),
      usage: {},
      interruptRequested: false,
      handleGeneration: 0,
      nextId: 1,
    }
    SURVIVORS.set(processKey, core)
    push(core, { t: 'state', change: { kind: 'session_started' } })
    core.state = { ...core.state, phase: 'idle', since: stamp() }
    return core
  }

  let sessionCounter = 0
  const mintSessionId = (): SessionId => `fake-session-${++sessionCounter}` as SessionId

  const coreFor = (sessionId: SessionId): SessionCore => {
    for (const core of SURVIVORS.values()) if (core.sessionId === sessionId) return core
    throw new Error(`fake: no session ${sessionId}`)
  }

  const control: FakeControl = {
    askInteraction(sessionId, spec) {
      return ask(
        coreFor(sessionId),
        typeof spec === 'string' ? defaultAskFor(spec) : spec,
        interactionSource,
      )
    },
    reaskInteraction(sessionId, id) {
      const core = coreFor(sessionId)
      const previous = core.interactions.get(id)
      // AT-LEAST-ONCE: a re-rendered menu mints a NEW id for the same logical
      // ask. Only a classifier-sourced driver may do this; a protocol-sourced
      // one has a real id from the provider and must not.
      if (!atLeastOnce) {
        throw new Error('fake: re-ask requested on a driver that declared exactly-once identity')
      }
      // Re-asking carries the ORIGINAL payload: a re-rendered menu shows the
      // same question, and a duplicate that said something else would not be
      // the duplicate this property is about.
      return ask(core, previous ?? defaultAskFor('permission'), interactionSource)
    },
    failTurn(sessionId, reason) {
      const core = coreFor(sessionId)
      const disposition = dispositionFor(reason)
      closeTurn(core, { ev: 'failed', turnEpoch: core.turnEpoch, reason, disposition })
      const kind = INTERACTION_FOR_FAILURE[reason]
      // The routing rule, implemented rather than described: `auth-expired`
      // becomes a `login` ask and `context-overflow` a `recovery` one, each
      // carrying the payload ITS kind takes rather than the bare reason.
      if (disposition === 'needs-human' && kind) {
        ask(
          core,
          kind === 'login'
            ? ({ kind, payload: { v: 1, provider: 'fake', reason: 'auth-expired' } } as const)
            : ({ kind: 'recovery', payload: askPayloadForOverflow() } as const),
          interactionSource,
        )
      }
    },
    completeTurn(sessionId) {
      const core = coreFor(sessionId)
      if (!core.turnOpen) return
      closeTurn(core, {
        ev: 'completed',
        turnEpoch: core.turnEpoch,
        verdict: core.interruptRequested ? 'interrupted' : 'done',
      })
      core.interruptRequested = false
    },
    processEvent(sessionId, ev) {
      const core = coreFor(sessionId)
      if (ev.ev === 'oomKilled') {
        core.oomEvents += 1
        core.alive = false
      }
      if (ev.ev === 'exited') core.alive = false
      push(core, { t: 'process', ev })
      for (const wake of [...core.wakers]) wake()
    },
    failNextVerification(sessionId) {
      coreFor(sessionId).failNextVerification = true
    },
    textDeliveries(sessionId) {
      return coreFor(sessionId).textDeliveries
    },
    restartSupervisor() {
      // Handles die; survivors do not. The observer generation bump happens on
      // ADOPT, not here — a restart nobody adopted through has not re-observed
      // anything, and pretending otherwise would fabricate a generation.
      //
      // `handleGeneration` is what makes "the handle dies" TRUE rather than
      // merely narrated. An earlier version only cleared the wakers, so the
      // pre-restart handle stayed fully usable and a test could have passed by
      // never letting go of it — which is precisely the mistake `adopt()`
      // exists to prevent a daemon from making.
      for (const core of SURVIVORS.values()) {
        core.wakers.clear()
        core.handleGeneration += 1
      }
    },
    connectWithoutSecret(sessionId) {
      const core = coreFor(sessionId)
      // An unauthenticated per-session endpoint holding a credentialed agent is
      // not acceptable even on loopback: every local process and user can reach
      // it (spec §6).
      return core.connectSecret ? { refused: true } : { refused: false }
    },
    emitItem(sessionId, item) {
      const core = coreFor(sessionId)
      core.items.push(item)
      push(core, { t: 'item', item: { kind: 'complete', item } })
    },
  }

  return {
    id,
    harness,
    family,
    capabilities,
    async create(spec: SessionSpec) {
      const sessionId = mintSessionId()
      // `resumeRefTiming: 'spawn'` — captured as early as the harness allows,
      // which for this fake is immediately. A driver declaring 'first-turn'
      // would hand `null` here and fill it after the first send.
      return makeHandle(
        newCore(sessionId, spec, { kind: `${harness}-session`, value: `native-${sessionId}` }),
      )
    },
    async resume(ref: ResumeRef, spec: SessionSpec) {
      return makeHandle(newCore(mintSessionId(), spec, ref))
    },
    async adopt(binding: SessionBinding) {
      const core = SURVIVORS.get(binding.process.key)
      // EXACT identity only. A prefix or heuristic match adopts the wrong
      // process, which is worse than not adopting at all.
      if (!core) throw new Error(`fake: no surviving process for ${binding.process.key}`)
      core.binding = { ...core.binding, bindingVersion: core.binding.bindingVersion + 1 }
      core.observerGeneration += 1
      push(core, {
        t: 'process',
        ev: { ev: 'adopted', bindingVersion: core.binding.bindingVersion },
      })
      return makeHandle(core)
    },
    control,
  }
}

/** A fake with the guarantees a SERVER-family driver must meet: structured
 *  interactions, native steer, and no unverified sends anywhere. */
export const createFakeServerDriver = (options: FakeDriverOptions = {}): FakeDriver =>
  createFakeDriver({
    family: 'server',
    interactionSource: 'protocol',
    atLeastOnceInteractions: false,
    mayReturnUnverified: false,
    requiresConnectSecret: true,
    ...options,
  })

/** A fake with the weaknesses the TERMINAL family is PERMITTED: unverified
 *  sends, classifier-sourced at-least-once interactions, no native steer. The
 *  corpus needs this one to prove the permitted-failures table does something. */
export const createFakeTerminalDriver = (options: FakeDriverOptions = {}): FakeDriver =>
  createFakeDriver({
    family: 'terminal',
    id: 'generic-pty',
    interactionSource: 'screen-classifier',
    atLeastOnceInteractions: true,
    mayReturnUnverified: true,
    nativeDeliveries: ['when-ready', 'queue', 'interrupt'],
    requiresConnectSecret: false,
    ...options,
  })
