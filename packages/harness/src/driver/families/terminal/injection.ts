/**
 * THE TERMINAL FAMILY'S INJECTION AND RECEIPT STATE MACHINE (POD-1761 W3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PORT AND NOT A WRAP
 * ---------------------------------------------------------------------------
 *
 * Everything else in W3 wraps: `create` is the existing spawn, `events` is the
 * existing observer fan-out, `export` is the existing handoff package. This one
 * file is the exception, and the plan says so openly. The injection mechanics
 * lived SERVER-side, in `apps/server/src/modules/sessions/inbox.ts` — the
 * bracketed paste, the 90ms CR, the submit-verify retries, the ready-poll drain
 * — while the daemon only wrote base64 `input` frames. A driver that lives on
 * the machine cannot wrap code that runs on the server, so the mechanics were
 * PORTED here, over ports, with every constant carried across verbatim.
 * POD-4414 Phase 0 (POD-4427) then deleted the server delivery copy outright:
 * this file is now the ONLY copy of the harness-delivery mechanics. The envelope
 * constructor the server keeps (`sessions/paste.ts`) serves shell raw transport
 * (`sendShellText`), not harness delivery — there is no second delivery path left
 * to keep in sync.
 *
 * THE CONSTANTS ARE NOT RE-TUNED. Each one below is a measured fact about a
 * shipped CLI's key parser or its startup settle, and re-deriving them from
 * first principles is how a working stack quietly stops working. They are copied
 * with their original names so a diff against `inbox.ts` reads as identity.
 *
 * THE SERVER'S COPY IS RETIRED. The one-phase duplication this paragraph used to
 * declare ended when the flag-off path it was written for was deleted instead of
 * retired (POD-4414 Phase 0, POD-4427). What remains of the duplication is the
 * envelope constructor alone, and it is split by side on purpose: the driver's
 * `paste.ts` builds it for harness turns, the server's `paste.ts` for shell
 * transport.
 *
 * ONE THING IS DELIBERATELY *NOT* A FAITHFUL PORT (POD-2708). The mechanics came
 * across verbatim; the TRUST BOUNDARY did not, because carrying it over verbatim
 * meant carrying over its absence. `inbox.ts` wrapped caller text in a bracketed
 * paste and stripped nothing, leaving the only defense in the message RENDERER,
 * which is a layer several callers of this machine never touch. `deliver` below
 * now crosses the boundary itself, through `./paste.ts` — read that file for what
 * the promise is and why it is the same promise for every origin.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A RECEIPT HONEST
 * ---------------------------------------------------------------------------
 *
 * The whole point of routing a send through here is that it comes back with a
 * receipt instead of a hope. Proof comes from ONE place: the harness's own
 * history (POD-4819 §3.3, POD-4905).
 *
 *   1. RECORDED — a prompt entry the harness wrote after the send started is
 *      this send: by its frame id for a wrapped message, by order plus text
 *      for a person's own words (the daemon's matcher applies both rules).
 *      `accepted`, naming the entry: delivered.
 *   2. HELD — the harness took the prompt into its queue and wrote only that
 *      (Claude's `queue-operation enqueue`). `accepted` with `held: 'memory'`;
 *      the entry follows through `onTranscriptItem`, or `onUnrecorded` says
 *      it will not come.
 *   3. Neither, inside the window ⇒ `unverified`. NOT `refused`, and NOT more
 *      retries: the keystrokes really were delivered, and the caller is told
 *      exactly how long we already waited so the decision is theirs.
 *
 * A HOOK IS NOT PROOF. Claude's `UserPromptSubmit` fired for a prompt that a
 * SIGKILL at +200 ms then left out of the history (POD-4862): the program can
 * announce a prompt it then loses. Hooks serve turn tracking; here Claude's
 * hook only lends its `prompt_id` to a send the history proved.
 *
 * WHAT IS DELIBERATELY NOT PROOF: the phase leaving `idle`. That is the
 * ready-poll heuristic the whole epic exists to retire — it says the CLI is busy,
 * which a resize, a spinner or somebody else's turn also says. Blind retries
 * stop on it. A fresh screen may instead show this send still in the input:
 * one CR can submit that retained paste even while busy (POD-5557), but only
 * the native history can upgrade the outcome.
 */

import type { HarnessRef, NotInConversationCause, TranscriptItemRef } from '@podium/model'
import type { QueueDrainAbandonedReason as WireQueueDrainAbandonedReason } from '@podium/protocol/daemon'
import type { ActingPrincipal, InputOrigin, TurnDelivery, TurnReceipt } from '../../turns.js'
import { injectionPayload } from './paste.js'

// ---------------------------------------------------------------------------
// The constants, carried over verbatim from apps/server/src/modules/sessions/inbox.ts
// ---------------------------------------------------------------------------

/** Gap between the pasted payload and the CR that submits it. */
export const SUBMIT_CR_DELAY_MS = 90
/** How long one submit-verification tick waits before deciding nothing echoed. */
export const SUBMIT_VERIFY_DELAY_MS = 1_600
/** Extra CRs a verification pass will send. Bounded, and NEVER extended because
 *  the outcome was `unverified` — that outcome exists so it does not have to be. */
export const SUBMIT_MAX_RETRIES = 2
/** Minimum time a session must have been live before the queue drains into it. */
export const READY_FLOOR_MS = 800
/** Output quiet required on top of the floor. */
export const READY_QUIET_MS = 600
/** Ceiling on waiting for quiet — a chatty session still gets its queue. */
export const READY_MAX_MS = 6_000
export const READY_POLL_MS = 200
export const QUEUE_DRAIN_DEADLINE_MS = 25_000
export const QUEUE_MESSAGE_SPACING_MS = 400

/**
 * How long a send waits for proof before answering `unverified`.
 *
 * DERIVED, not chosen: the retry ladder is `SUBMIT_MAX_RETRIES` extra CRs one
 * `SUBMIT_VERIFY_DELAY_MS` apart, and the window is one tick longer than the
 * last of them so the echo produced BY that last CR still has a chance to be
 * seen. Anything shorter would report `unverified` for sends the existing
 * mechanism was still in the middle of rescuing.
 */
export const VERIFICATION_WINDOW_MS = SUBMIT_VERIFY_DELAY_MS * (SUBMIT_MAX_RETRIES + 1)

/**
 * How long an `unverified` send keeps watching for its transcript echo, as
 * late proof that it landed (POD-4840).
 *
 * THE SAME CEILING THE WINDOW ALREADY HOLDS A DURABLE ROW FOR (`awaitProof`'s
 * `heldUntil`): a prompt typed while the agent is busy is recorded only when
 * the running turn or tool call ends, and 30 minutes is how long this machine
 * already believes such a turn may run. A proof later than that is not
 * awaited. The ceiling is the backstop, not the usual end: the watch closes
 * first after four later prompt entries (see
 * {@link AcceptWatch.passed}).
 */
export const LATE_PROOF_WAIT_MS = 30 * 60_000

/**
 * The ESC this module is allowed to write.
 *
 * NOT AN EXCEPTION TO THE PASTE BOUNDARY — the distinction the boundary draws is
 * between control bytes the DRIVER mints and text the CALLER supplied. `interrupt`
 * requesting a fence is the driver saying ESC in its own voice; caller text is
 * content and never gets a voice. See `./paste.ts`.
 */
export const ESC = '\x1b'

/**
 * WHAT KEY INTERRUPTS THIS HARNESS, AND WHAT IT COSTS WHEN IDLE (POD-3981).
 *
 * There is no universal abort key, and the same byte can be harmless in one
 * CLI and terminal in another — so both halves come from the harness manifest
 * (via the daemon's `TerminalHarnessProfile`), never from a constant here.
 * The shape mirrors the legacy answer exactly: `SessionInbox.abortKeyFor`
 * sends `harnessInterrupt(kind).bytes`, and sends NOTHING when
 * `quitsWhenIdle` meets a session that is not computing.
 */
export interface TerminalInterruptConfig {
  /** The exact bytes the harness's manifest declares as its interrupt key. */
  bytes: string
  /** Whether pressing the key while NO turn is running exits the CLI. */
  quitsWhenIdle: boolean
}

/**
 * What a caller that names no harness gets: esc with quits-when-idle false,
 * the conservative guess (opencode and grok declare other keys — POD-4638).
 * The default is spelled out rather than reached for because the day a
 * manifest says otherwise the call site must say so too.
 */
export const DEFAULT_TERMINAL_INTERRUPT: TerminalInterruptConfig = {
  bytes: ESC,
  quitsWhenIdle: false,
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type TimerHandle = { readonly __timer: unique symbol } | unknown

/** Armed before the first byte. Manifest adapters match frame id, order plus
 * text, or a timely submit hook linked to a saved prompt's native id. */
export interface AcceptPort {
  /** `turnId` names the send's typing to the foreign-write counter
   *  (`typingStarts`), which order credit compares against. */
  watch(text: string, turnId?: string): AcceptWatch
}

/** What the history showed for a send inside its window. */
type Proven =
  | { kind: 'recorded'; transcriptItem?: TranscriptItemRef; harnessRef?: HarnessRef }
  | { kind: 'held' }
  | ({ kind: 'disproved' } & Disproof)

/** The program's own evidence that a prompt is not in its conversation
 *  (POD-4887; spec §6.1 N2b, N4), and the words for it. */
export interface Disproof {
  readonly proof: NotInConversationCause
  readonly reason: string
}

/** What an accept observation said about the prompt it credited. */
export interface AcceptSeen {
  /** The harness's own record of the prompt — set by a transcript echo, which
   *  IS that record (POD-4774). */
  readonly transcriptItem?: TranscriptItemRef
  /** The program's own ids the observation carried for the prompt — Claude's
   *  hook `prompt_id` (POD-4841). Only as good as the observation's timing:
   *  the send decides whether it may be this prompt's. */
  readonly harnessRef?: HarnessRef
}

export interface AcceptWatch {
  readonly typingStartedAtMs?: number
  /** Resolves only for this prompt, with what the observation saw. It never
   *  resolves otherwise: the caller's window ends the wait. */
  readonly accepted: Promise<AcceptSeen>
  /**
   * Resolves once the harness has taken this prompt into its queue without
   * recording it in the conversation (Claude's `enqueue`, POD-4905): a held
   * receipt, never a delivery. Absent where the channel cannot tell.
   */
  readonly held?: Promise<void>
  /**
   * Resolves after four later prompt entries or thirty minutes from typing,
   * without proof. A re-read counts each entry once. Only a late watch
   * reads it; inside the window a later entry changes nothing. Absent where
   * the channel cannot tell, as for a hook.
   */
  readonly passed?: Promise<void>
  /**
   * Resolves once the program's OWN evidence proves this prompt is not in its
   * conversation (POD-4887; spec §6.1): it recorded dropping it (N2b), or its
   * process exited and its history, read to the end after the exit, holds
   * nothing for it (N4). Never from a timer, a hook, the screen or an agent
   * state. Absent where the channel cannot tell.
   */
  readonly disproved?: Promise<Disproof>
  /** Idempotent; removes the waiter when the send ends. */
  cancel(): void
  /** Own Enter, stamped before dispatch so even a synchronous hook can link. */
  submitted?(): void
  /** Persist the actual typing floor before any content reaches the terminal. */
  typingStarts?(): Promise<void>
}

/** Channel names retained for hosts using the existing injection ports. */
export type HookAcceptPort = AcceptPort
export type EchoAcceptPort = AcceptPort
export type HookAcceptWatch = AcceptWatch

/**
 * WHOSE WRITE THIS IS (POD-4888). `message` is a turn's own typing — its paste,
 * its Enter and its submit retries; `control` is everything else this machine
 * writes (the interrupt key). The daemon counts every `control` write as a
 * foreign write into the terminal, which is what lets a person's own words be
 * matched to the history by order (spec §5.3). Required, so no write is
 * classified by default.
 */
export type TerminalWriteRole = 'message' | 'control'

/** Everything the machine needs from the world, and nothing more. Each one is a
 *  READ or a WRITE on the session's terminal; none of them is a mechanism the
 *  contract exposes. */
export interface TerminalInjectionPorts {
  /** Write UTF-8 text to the session's PTY, saying whose write it is. The daemon base64-encodes. */
  write(text: string, role: TerminalWriteRole): void
  /**
   * A turn's typing starts NOW: called immediately before its first byte, so
   * the daemon can snapshot the session's foreign-write count for it (spec
   * §5.3, POD-4888). Only for turns that carry an id.
   */
  typingStarts?(turnId: string): void
  /** Is there a live process to type into? `starting` counts — a session whose
   *  CLI is still painting is exactly the one the queue is waiting for. */
  running(): boolean
  /**
   * Has the CLI finished starting?
   *
   * SEPARATE FROM `running()` ON PURPOSE, and the separation is load-bearing for
   * the drain below. `SessionInbox.drain` only ever types into a session whose
   * status is `live`; a `starting` one it keeps polling and, at the deadline,
   * abandons WITHOUT delivering. That is not fussiness — a grok TUI that has
   * bound but not finished painting swallows everything typed at it (POD-549),
   * which is the silent loss the durable row exists to prevent, and it is
   * precisely why `sendText` queues a `starting` raw-first-turn session in the
   * first place. A drain that could not tell the two apart would deliver into the
   * one state the queue was waiting out.
   */
  live(): boolean
  /** The session's normalized phase, or undefined while unknown. */
  phase(): string | undefined
  /** Fresh input-box evidence; undefined means no identifiable input box. */
  readInput?(): Promise<string | undefined>
  /** Foreign writes while the host owns the writer lease; undefined otherwise. */
  foreignWriteCount?(): number | undefined
  /** When the PTY last produced output — the drain's quiet detector. */
  lastOutputAtMs(): number
  now(): number
  setTimer(fn: () => void, delayMs: number): TimerHandle
  clearTimer(handle: TimerHandle): void
  /** Claude's `UserPromptSubmit`, read ONLY for the program's own prompt id
   *  (POD-4841): a hook is never a receipt (POD-4905). Absent elsewhere. */
  hookAccept?: AcceptPort
  /**
   * The history channel: the only proof. Absent only where nothing can
   * observe the harness's transcript at all — and then every send answers
   * `unverified`. That is the honest answer: the bytes went out and nothing
   * confirmed them.
   */
  echoAccept?: AcceptPort
  /** Grok's fresh TUI ignores bracketed paste until a native first turn
   *  (POD-549/POD-901): type the first prompt as raw keystrokes instead. */
  rawFirstTurn(): boolean
  /** Whether this harness needs the submit-verify CR nudges at all. Reading the
   *  transcript for an echo happens either way — that is a read, and a read
   *  cannot change what the CLI does. */
  needsSubmitVerification(): boolean
  /** The turn epoch the observer currently reports, when there is an observation
   *  lease. Absent/0 means the driver counts its own — see `nextTurnEpoch`. */
  observedTurnEpoch(): number
  /**
   * RE-AUTHORIZE ONE QUEUED TURN, immediately before it is typed.
   *
   * The mirror of `SessionInbox.drain`'s `authorizeAtDrain`, whose comment calls
   * that call site "the security boundary … Nothing accepted at enqueue is
   * trusted now" — because a turn can sit in a queue across a revocation, an
   * ownership change or a session moving machines, and the answer that was true
   * at enqueue is not the answer now.
   *
   * ABSENT MEANS THE COMPOSER DOES NOT AUTHORIZE HERE, not that everything is
   * permitted. Today that is the truth for the daemon: the durable FIFO is the
   * server's, the server completes `queue` on its own side and re-authorizes at
   * ITS drain, and nothing forwards a queued turn to the machine. What this port
   * buys is that the driver-side queue CARRIES the principal (see `QueuedTurn`)
   * and has the seam to use it, so the day a queue is forwarded the decision is
   * possible rather than needing the mechanism invented under pressure.
   */
  authorizeAtDrain?(turn: QueuedTurn): { ok: true } | { ok: false; reason: string }
  /** A turn the drain refused. Reported, never silently dropped. */
  onDrainRejected?(turn: QueuedTurn, reason: string): void
  /**
   * THE DRAIN GAVE UP OR WAS TORN DOWN, AND SOMEBODY HAS TO HEAR IT
   * (POD-2107, POD-2202).
   *
   * `QUEUE_DRAIN_DEADLINE_MS` elapsed with the session still not live, so the
   * turns below were never typed. Until this port existed that outcome made no
   * sound at all: `stop()` set a boolean, the caller kept a receipt that said
   * `queued`, and the only way to find out was to notice that an answer never
   * came. A queue whose failure mode is invisible is the POD-549 loss wearing a
   * durable row's clothes, and this is the seam that ends the silence.
   *
   * THE REPORT IS THE POINT OF NO RETURN FOR THESE TURNS. Both reasons discard
   * this in-memory copy right after reporting — `never-live` no longer holds the
   * turns back for a later enqueue to re-drain, because the consumer's durable row
   * goes terminal on the report (POD-2132) and a queue that typed its retained copy
   * afterwards would deliver bytes the ledger already recorded as undelivered, with
   * no receipt anywhere. What is owed is stated once, here, and then owed by nobody.
   * (The RULE governing consumers is stated in three places and must agree in all
   * of them — here, `RuntimeQueueDrainAbandonedMessage` and
   * `RuntimeSendResultMessage`. It is only the OWING of these particular turns
   * that ends here.)
   *
   * THE HOST MUST MAKE THE TRANSPORT AT-LEAST-ONCE. Before this callback returns,
   * it durably records the report; it replays while connected and across host
   * restarts, and removes that record only after the receipt consumer
   * acknowledges its durable correction. A report can therefore repeat and may
   * carry turn ids a consumer already handled. CONSUMERS MUST BE IDEMPOTENT UNDER
   * REPEATS, keyed on turn id, before correcting receipts — retryable means "safe
   * to hear twice", never "safe to deliver twice". NOT the same as "must dedupe":
   * a status write guarded on its own current state is already safe to replay,
   * and an append-only observation event may honestly fire once per report
   * rather than once per turn (POD-2297 review, E3).
   */
  onDrainAbandoned?(turns: readonly QueuedTurn[], reason: QueueDrainAbandonedReason): void
}

/**
 * Terminal's OWN arms of the wire vocabulary, derived from it rather than
 * restated: widening `@podium/protocol`'s enum must never silently widen what
 * this family claims it can report. `delivery-failed` is the server family's
 * (POD-2297) — a drain that never got the session typeable has not attempted a
 * send, so it cannot honestly say one failed.
 */
export type QueueDrainAbandonedReason = Extract<
  WireQueueDrainAbandonedReason,
  'never-live' | 'teardown'
>

export interface DeliverOptions {
  initialPrompt?: boolean
  signal?: AbortSignal
  origin: InputOrigin
  /** `when-ready` and `interrupt` reach here; `queue` is the queue below and
   *  `steer` has already been downgraded to it by the caller. */
  delivery: Extract<TurnDelivery, 'when-ready' | 'interrupt'>
  /** Set by the interrupt path: the manifest key already went out, so the `needs_user`
   *  refusal below does not apply (the key is what clears the prompt). */
  afterEsc?: boolean
  /** The entry of a send answered `accepted` with `held`, once the harness
   *  records it (POD-4774, POD-4905). Called at most once. */
  onTranscriptItem?: (item: TranscriptItemRef, harnessRef?: HarnessRef) => void
  /** A held send the harness will not record any more (POD-4849): its watch
   *  closed first. Called at most once, never with `onTranscriptItem`. With
   *  `proof`, the program's own evidence says it is not in the conversation
   *  (POD-4887) — also for an `unverified` send, in or after the window. */
  onUnrecorded?: (reason: string, proof?: NotInConversationCause) => void
  /** The echo of a send that answered `unverified`, when it lands after the
   *  window (POD-4840). Called at most once. */
  onLateProof?: (seen: AcceptSeen) => void
  /** The turn's id, when it has one: names its typing to `typingStarts`. */
  turnId?: string
  /** The delivery journal's synchronous fence before the first byte. */
  onTypingStarted?: () => void
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface QueuedTurn {
  id: string
  text: string
  origin: InputOrigin
  /** WHO ASKED FOR THIS TURN, carried from `send()` to the moment it is typed.
   *  A queue that forgets its sender can only be drained as somebody else. */
  principal?: ActingPrincipal
}

export interface TerminalInjectionMachine {
  /** Type one turn and answer with a receipt. */
  deliver(text: string, options: DeliverOptions): Promise<TurnReceipt>
  /** Enqueue one turn for the ready-poll drain, and answer with its position. */
  enqueue(
    text: string,
    options: { origin: InputOrigin; id: string; principal?: ActingPrincipal },
  ): TurnReceipt
  /** REQUEST a fence: the manifest's interrupt key, and nothing else. The fence
   *  itself only ever arrives as a provider-confirmed terminal event on the
   *  causal stream. */
  interrupt(): void
  /** Open queue depth, for `snapshot()` and diagnostics. */
  queueDepth(): number
  /** Stop every timer and report then discard queued turns (session teardown). */
  dispose(): void
}

export function createTerminalInjection(
  ports: TerminalInjectionPorts,
  interrupt: TerminalInterruptConfig = DEFAULT_TERMINAL_INTERRUPT,
): TerminalInjectionMachine {
  const queue: QueuedTurn[] = []
  const timers = new Set<TimerHandle>()
  let draining = false
  /** Driver-local turn counter. See `nextTurnEpoch`. */
  let localTurnEpoch = 0
  let pasteGeneration = 0
  let disposed = false
  /** Held sends still waiting for their record: told when the session ends. */
  const heldWatches = new Set<() => void>()

  const setTimer = (fn: () => void, delayMs: number): TimerHandle => {
    const handle = ports.setTimer(() => {
      timers.delete(handle)
      if (!disposed) fn()
    }, delayMs)
    timers.add(handle)
    return handle
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimer(resolve, ms)
    })

  /**
   * THE EPOCH A RECEIPT REPORTS.
   *
   * The observer's epoch is authoritative wherever there is one: it is minted by
   * the causal protocol from the harness's own signals, and a receipt that
   * disagreed with the event stream would be worse than no receipt. Where the
   * harness has no causal observation lease (every terminal harness but Claude
   * today), there is nothing to defer to, so the driver counts — MONOTONICALLY,
   * because the conformance corpus pins that an epoch never goes backwards across
   * a rebind and a consumer correlating events by it must never see a reused one.
   */
  const nextTurnEpoch = (): number => {
    const observed = ports.observedTurnEpoch()
    localTurnEpoch = Math.max(observed, localTurnEpoch + 1)
    return localTurnEpoch
  }

  type InputSubmission = {
    body: string
    inputWasKnown: boolean
    startedEmpty: boolean
    generation: number
    foreignWrites: number | undefined
  }
  const readInput = async (): Promise<string | undefined> =>
    ports.readInput?.().catch(() => undefined)
  const ownsInput = (submission: InputSubmission): boolean =>
    submission.startedEmpty && submission.generation === pasteGeneration &&
    submission.foreignWrites !== undefined &&
    submission.foreignWrites === ports.foreignWriteCount?.()
  const retainedInput = (draft: string, body: string): boolean => {
    // Claude 2.1.283/289 collapse a multiline paste into this single token.
    // Claim it only with an initially empty box and unchanged writer ownership.
    if (/^\[Pasted text #\d+(?: \+\d+ lines?)?\]$/.test(draft.trim())) return true
    // Screen wrapping and the missed Enter can add whitespace to the draft.
    const compact = (value: string): string => value.replace(/\s+/gu, '')
    return compact(body).length > 0 && compact(draft) === compact(body)
  }

  /**
   * The ported `scheduleSubmitVerify` ladder, plus the history watch that
   * turns it into evidence instead of a nudge.
   *
   * Returns what the history showed — the prompt recorded (with its entry),
   * or held in the harness's queue — or null when the window closed without
   * either.
   *
   * THE WINDOW STAYS OPEN WHILE THE HARNESS IS BUSY (POD-4905, spec §5.3): a
   * prompt typed during a running tool call or text stream is recorded only
   * when that ends (+6–10 s measured), so every tick that reads the agent
   * `working` or `compacting` moves the deadline out again, up to the
   * 30-minute ceiling a running turn is believed to have.
   */
  async function awaitProof(
    echoWatch: AcceptWatch | undefined,
    signal?: AbortSignal,
    initialPrompt = false,
    submitted?: () => void,
    inputSubmission?: InputSubmission,
  ): Promise<Proven | null> {
    if (!echoWatch) return null
    let recorded: AcceptSeen | undefined
    let held = false
    let disproved: Disproof | undefined
    void echoWatch.accepted.then((seen) => {
      recorded ??= seen
    })
    void echoWatch.held?.then(() => {
      held = true
    })
    void echoWatch.disproved?.then((disproof) => {
      disproved ??= disproof
    })
    const proven = (): Proven | null => {
      if (recorded) {
        const transcriptItem = recorded.transcriptItem
        return { kind: 'recorded', ...(transcriptItem ? { transcriptItem } : {}),
          ...(recorded.harnessRef ? { harnessRef: recorded.harnessRef } : {}) }
      }
      // A DROP OUTRANKS THE HOLD IT ENDS (POD-4887): Claude writes `enqueue`
      // and then, 25–32 ms later, `dropped_by_hook`; one read may carry both.
      if (disproved) return { kind: 'disproved', ...disproved }
      return held ? { kind: 'held' } : null
    }
    let retriesLeft = ports.needsSubmitVerification() ? SUBMIT_MAX_RETRIES : 0
    let nudging = true
    let recoveredInput = false
    const windowMs = initialPrompt ? 30_000 : VERIFICATION_WINDOW_MS
    let deadline = ports.now() + windowMs
    const heldUntil = (echoWatch.typingStartedAtMs ?? ports.now()) + LATE_PROOF_WAIT_MS

    while (ports.now() < deadline && ports.now() < heldUntil) {
      // Race the proof against the tick so a proof that has already landed is
      // not made to wait out a 1.6s poll it already answered.
      const tick = sleep(SUBMIT_VERIFY_DELAY_MS)
      const settled: Promise<unknown>[] = [tick, echoWatch.accepted]
      if (echoWatch.held) settled.push(echoWatch.held)
      if (echoWatch.disproved) settled.push(echoWatch.disproved)
      await Promise.race(settled)
      if (recorded || held || disproved) return proven()
      if (signal?.aborted) return null
      // A dead session cannot record and cannot be nudged. Stop; the caller gets
      // `unverified`, which is the truth: the bytes went out, nothing confirmed.
      if (!ports.running()) return null
      const phase = ports.phase()
      // Phase gates only the blind ladder. Busy Claude can still have this
      // send sitting unsubmitted in its input box (POD-5557).
      if (phase !== undefined && phase !== 'idle') nudging = false
      if (phase === 'working' || phase === 'compacting') deadline = ports.now() + windowMs
      if (retriesLeft === 0) continue
      if (ports.readInput) {
        const draft = await readInput()
        // A proof, abort, detach or another writer can arrive during the flush.
        if (recorded || held || disproved) return proven()
        if (signal?.aborted || !ports.running()) return null
        if (draft !== undefined) {
          if (recoveredInput || !inputSubmission || !ownsInput(inputSubmission) ||
            !retainedInput(draft, inputSubmission.body)) continue
          recoveredInput = true
          retriesLeft = 0
          submitted?.()
          ports.write('\r', 'message')
          continue
        }
        // A box that vanished may be a native dialog. Missing evidence does
        // not authorize a blind CR after we had an identifiable input box.
        if (inputSubmission?.inputWasKnown) continue
      }
      // Hosts without input evidence retain their existing idle-only ladder.
      if (nudging) {
        retriesLeft -= 1
        submitted?.()
        ports.write('\r', 'message')
      }
    }
    return proven()
  }

  async function deliver(text: string, options: DeliverOptions): Promise<TurnReceipt> {
    if (options.signal?.aborted || !ports.running()) {
      return { outcome: 'refused', refusal: { reason: 'not_running' } }
    }
    // ONE OF EXACTLY TWO REFUSALS THE TERMINAL PATH HAS TODAY (inbox.ts ~713).
    // An open native prompt swallows a paste, so typing into it is not delivery.
    // The interrupt path is exempt because its key is what dismisses the prompt.
    if (!options.afterEsc && ports.phase() === 'needs_user') {
      return {
        outcome: 'refused',
        refusal: { reason: 'needs_user', detail: 'a native prompt is open' },
      }
    }

    // THE TRUST BOUNDARY, AND IT IS CROSSED EXACTLY HERE (POD-2708).
    //
    // Everything below this line is about bytes that are already content. The
    // caller's text may be anything at all — it reached `send()` from a human, a
    // controller, the steward, mail, an auto-continue or the system, and the
    // promise this driver makes about it does not vary by which — so the payload
    // is built by the one constructor that cannot produce an envelope without
    // applying the boundary first. `./paste.ts` carries the argument for why
    // dropping the ESC class is a proof rather than a pattern match.
    //
    // BUILT BEFORE THE WATCHES ARE ARMED, not just before the write. The proof
    // below is matched against what the CLI RECEIVED — `payload.body` — and a
    // watcher armed with the pre-boundary text would fail to recognise its own
    // record and report `unverified` for a turn that landed.
    const payload = injectionPayload(text, { rawFirstTurn: ports.rawFirstTurn() })
    // BOTH WATCHES ARE ARMED WITH `payload.body`, and both are started BEFORE the
    // write: a fast CLI can fire `UserPromptSubmit`, or record its user turn,
    // before we would otherwise be listening, and a record we missed reads as
    // `unverified`. The history watch is the proof; the hook watch only lends
    // Claude's `prompt_id` to a send the history proved.
    const hookWatch = ports.hookAccept?.watch(payload.body, options.turnId)
    const echoWatch = ports.echoAccept?.watch(payload.body, options.turnId)
    const typingStartedAtMs = echoWatch?.typingStartedAtMs ?? ports.now()
    const submitted = () => { echoWatch?.submitted?.(); hookWatch?.submitted?.() }
    let hookIds: HarnessRef | undefined
    void hookWatch?.accepted.then((seen) => {
      if (seen.harnessRef?.length) hookIds ??= seen.harnessRef
    })
    /**
     * WHETHER THE HOOK'S IDS CAN BE THIS PROMPT'S (POD-4841). Measured on
     * Claude 2.1.284 (POD-4834): typed into an idle agent, the hook fires for
     * this prompt with its own `prompt_id`; typed while a turn runs, the hook
     * at Enter may carry the RUNNING turn's id. So only a send that began on
     * an idle agent keeps them.
     */
    const idleAtSend = ports.phase() === 'idle'
    const ids = (): { harnessRef?: HarnessRef } =>
      hookIds && idleAtSend ? { harnessRef: hookIds } : {}
    /** The history watch that outlives this call: late proof, or a held send's record. */
    let kept: AcceptWatch | undefined
    try {
      if (echoWatch?.typingStarts) await echoWatch.typingStarts()
      const generationBeforeRead = pasteGeneration
      const foreignWrites = ports.foreignWriteCount?.()
      const initialInput = ports.readInput ? await readInput() : undefined
      if (options.signal?.aborted || !ports.running())
        return { outcome: 'refused', refusal: { reason: 'not_running' } }
      const inputSubmission: InputSubmission = {
        body: payload.body,
        inputWasKnown: initialInput !== undefined,
        startedEmpty: initialInput === '' && generationBeforeRead === pasteGeneration &&
          foreignWrites === ports.foreignWriteCount?.(),
        foreignWrites,
        generation: ++pasteGeneration,
      }
      if (options.turnId !== undefined) ports.typingStarts?.(options.turnId)
      options.onTypingStarted?.()
      ports.write(payload.bytes, 'message')
      // A PASTE IS ALWAYS SUBMITTED (POD-4776). Once its bytes are in the
      // composer, stopping short of the Enter would leave the text sitting in
      // the agent's prompt, to be sent along with whatever the operator types
      // next. An abort after this point ends the wait for proof below, never
      // the submit itself.
      setTimer(() => {
        if (ports.running()) {
          submitted()
          ports.write('\r', 'message')
        }
      }, SUBMIT_CR_DELAY_MS)

      const verificationStartedAt = ports.now()
      const proof = await awaitProof(echoWatch, options.signal, options.initialPrompt, submitted, inputSubmission)
      const unverified = (): TurnReceipt => ({
        outcome: 'unverified',
        deliveredAs: options.delivery,
        verificationWindowMs: ports.now() - verificationStartedAt,
        at: new Date(ports.now()).toISOString(),
      })
      if (!proof) {
        if (echoWatch && (options.onLateProof || options.onUnrecorded)) {
          awaitLateProof(echoWatch, options, typingStartedAtMs)
          kept = echoWatch
        }
        return unverified()
      }
      if (proof.kind === 'disproved') {
        // THE PROGRAM'S OWN "NO" INSIDE THE WINDOW (POD-4887): typed, so the
        // receipt stays `unverified`; the proof goes first, and the delivery
        // queue settles the row on it — `failed`, safe to resend.
        options.onUnrecorded?.(proof.reason, proof.proof)
        return unverified()
      }
      if (proof.kind === 'held' && echoWatch) {
        followHeld(echoWatch, options, ids, typingStartedAtMs)
        kept = echoWatch
      }
      return {
        outcome: 'accepted',
        turnEpoch: nextTurnEpoch(),
        deliveredAs: options.delivery,
        provenBy: 'transcript-echo',
        ...(proof.kind === 'recorded' && proof.transcriptItem
          ? { transcriptItem: proof.transcriptItem }
          : {}),
        ...(proof.kind === 'held' ? { held: 'memory' as const } : {}),
        ...ids(),
        ...(proof.kind === 'recorded' && proof.harnessRef ? { harnessRef: proof.harnessRef } : {}),
        at: new Date(ports.now()).toISOString(),
      }
    } finally {
      hookWatch?.cancel()
      if (echoWatch !== kept) echoWatch?.cancel()
    }
  }

  /**
   * Keep an `unverified` send's history watch open, bounded, for late proof
   * that it landed (POD-4840). The same match as inside the window — a frame
   * id, or order plus text — so a late proof is exactly as strong as a timely
   * one. It closes on the first of: the proof; the history moving past the
   * send without it (`passed`); `LATE_PROOF_WAIT_MS`; the session's teardown;
   * the program's own "no" (POD-4887), passed on as a late one. `passed` is
   * attached first, so a history that moved on before the proof arrived
   * closes the watch even when both are already settled.
   */
  function awaitLateProof(
    echoWatch: AcceptWatch,
    options: Pick<DeliverOptions, 'onLateProof' | 'onUnrecorded'>,
    typingStartedAtMs: number,
  ): void {
    let open = true
    const close = (): void => {
      if (!open) return
      open = false
      ports.clearTimer(timer)
      echoWatch.cancel()
    }
    const timer = setTimer(close, Math.max(0, typingStartedAtMs + LATE_PROOF_WAIT_MS - ports.now()))
    void echoWatch.passed?.then(close)
    void echoWatch.accepted.then((seen) => {
      if (!open || disposed) return
      close()
      options.onLateProof?.(seen)
    })
    // A LATE "NO" (POD-4887): the program exited after the window and its
    // history, read to the end, lacks the prompt — or it recorded the drop.
    void echoWatch.disproved?.then(({ reason, proof }) => {
      if (!open || disposed) return
      close()
      options.onUnrecorded?.(reason, proof)
    })
  }

  /**
   * FOLLOW A HELD SEND TO ITS RECORD (POD-4905, POD-4849). The harness holds
   * the prompt in memory: it names the entry when it records it, and says it
   * will not when the watch closes first — the history moved past it, the
   * late-proof ceiling passed, or the session was torn down. Closing proves
   * no "no": the delivery queue settles such a row as unconfirmed. Only the
   * program's own evidence does (POD-4887): its drop record, or its exit with
   * a history that lacks the prompt — and that is passed on as the proof.
   */
  function followHeld(
    echoWatch: AcceptWatch,
    options: DeliverOptions,
    ids: () => { harnessRef?: HarnessRef },
    typingStartedAtMs: number,
  ): void {
    let open = true
    const close = (reason: string, proof?: NotInConversationCause): void => {
      if (!open) return
      open = false
      ports.clearTimer(timer)
      heldWatches.delete(onDispose)
      echoWatch.cancel()
      options.onUnrecorded?.(reason, proof)
    }
    const onDispose = (): void => close('the session ended before the harness recorded it')
    heldWatches.add(onDispose)
    const timer = setTimer(
      () => close('the harness did not record it within the maximum wait'),
      Math.max(0, typingStartedAtMs + LATE_PROOF_WAIT_MS - ports.now()),
    )
    void echoWatch.passed?.then(() => close('the history moved past it without recording it'))
    // The program dropped it, or exited without it (POD-4887): a proven "no".
    void echoWatch.disproved?.then(({ reason, proof }) => close(reason, proof))
    void echoWatch.accepted.then((seen) => {
      if (!open || disposed) return
      open = false
      ports.clearTimer(timer)
      heldWatches.delete(onDispose)
      echoWatch.cancel()
      if (seen.transcriptItem) options.onTranscriptItem?.(seen.transcriptItem, seen.harnessRef ?? ids().harnessRef)
      else options.onUnrecorded?.('the harness recorded it under no entry id')
    })
  }

  /**
   * The ported ready-poll drain (`SessionInbox.drain`).
   *
   * WHY A QUEUE LIVES IN THE DRIVER AT ALL. The durable FIFO is the server's — a
   * DB table, so a queued turn survives a restart — and the server's runtime
   * pass-through answers `queued` from it directly rather than forwarding. What
   * the driver owns is the DELIVERY side of the same mechanism: something has to
   * decide when a settling CLI is ready to be typed into, and that decision is
   * made from the PTY's output timing, which only the machine can see.
   */
  function drain(): void {
    if (draining || queue.length === 0) return
    draining = true
    const deadline = ports.now() + QUEUE_DRAIN_DEADLINE_MS
    let liveAtMs = 0
    let baseOutputMs = 0
    const stop = (): void => {
      draining = false
    }

    const deliverNext = (): void => {
      const head = queue[0]
      if (!head || !ports.running()) {
        stop()
        return
      }
      // THE SECURITY BOUNDARY, in the same position `SessionInbox.drain` puts it:
      // immediately before the bytes go out, not at enqueue. A refused turn is
      // DROPPED and reported — leaving it at the head would retry a decision that
      // has already been made against it, forever.
      const verdict = ports.authorizeAtDrain?.(head) ?? { ok: true as const }
      if (!verdict.ok) {
        queue.shift()
        ports.onDrainRejected?.(head, verdict.reason)
        if (queue.length > 0) setTimer(deliverNext, QUEUE_MESSAGE_SPACING_MS)
        else stop()
        return
      }
      void deliver(head.text, { origin: head.origin, delivery: 'when-ready', turnId: head.id }).then((receipt) => {
        // A refusal leaves the head in place: the session is not running, or a
        // native prompt is open, and re-typing into either would be the silent
        // loss the durable row exists to prevent.
        if (receipt.outcome === 'refused') {
          stop()
          return
        }
        queue.shift()
        if (queue.length > 0) setTimer(deliverNext, QUEUE_MESSAGE_SPACING_MS)
        else stop()
      })
    }

    /**
     * VERBATIM in shape from `SessionInbox.drain`'s tick, including the part that
     * is easy to lose in a port: the settle test and the delivery are inside the
     * `live` branch, and `liveAtMs` is stamped when the session became LIVE.
     *
     * A `starting` session therefore does not start the floor clock and cannot be
     * delivered into — it is polled until it goes live, and at the deadline the
     * drain gives up WITHOUT typing. Flattening this into "running counts" would
     * type into a CLI that is still painting, which is the POD-549 no-op: the
     * bytes vanish, the queue row is consumed, and nothing anywhere reports a
     * loss. `READY_MAX_MS` is a ceiling on waiting for QUIET, never a licence to
     * type into a session that never became live.
     */
    const tick = (): void => {
      if (!ports.running()) {
        stop()
        return
      }
      const now = ports.now()
      if (ports.live()) {
        if (!liveAtMs) {
          liveAtMs = now
          baseOutputMs = ports.lastOutputAtMs()
        }
        const settled =
          ports.lastOutputAtMs() > baseOutputMs &&
          now - liveAtMs >= READY_FLOOR_MS &&
          now - ports.lastOutputAtMs() >= READY_QUIET_MS
        if (settled || now - liveAtMs >= READY_MAX_MS || now >= deadline) {
          deliverNext()
          return
        }
      } else if (now >= deadline) {
        // NEVER WENT LIVE. This is the one exit from the drain that used to be
        // completely silent — not a refusal, not an exit, just a timer that
        // stopped — and it is the exit a dropped `bind` produced (POD-2107).
        // Reported before `stop()`, with the queue intact, so a consumer reads
        // exactly what is still undelivered — then dropped, because the consumer
        // records these turns as never delivered and no longer expects them.
        ports.onDrainAbandoned?.([...queue], 'never-live')
        queue.length = 0
        stop()
        return
      }
      setTimer(tick, READY_POLL_MS)
    }
    setTimer(tick, READY_POLL_MS)
  }

  return {
    deliver,
    enqueue(text, options) {
      queue.push({
        id: options.id,
        text,
        origin: options.origin,
        ...(options.principal ? { principal: options.principal } : {}),
      })
      drain()
      return {
        outcome: 'queued',
        // 1-based: the conformance corpus reads a position of 0 as "a shrug
        // wearing a number", and it is right to.
        position: queue.length,
        deliveredAs: 'queue',
        at: new Date(ports.now()).toISOString(),
      }
    },
    interrupt() {
      if (!ports.running()) return
      // THE MANIFEST'S IDLE GUARD, ported from `SessionInbox.abortKeyFor`
      // (POD-1214): a key that quits an idle CLI must never be the thing that
      // kills the session, so with nothing to stop there is nothing to send.
      // `working` AND `compacting` count as computing — the same two
      // `isAgentComputing` counts — so a stop is withheld exactly when there
      // is no turn to stop, and never while one is running.
      const phase = ports.phase()
      if (interrupt.quitsWhenIdle && phase !== 'working' && phase !== 'compacting') return
      ports.write(interrupt.bytes, 'control')
    },
    queueDepth: () => queue.length,
    dispose() {
      if (disposed) return
      for (const close of [...heldWatches]) close()
      disposed = true
      for (const handle of timers) ports.clearTimer(handle)
      timers.clear()
      try {
        if (queue.length > 0) ports.onDrainAbandoned?.([...queue], 'teardown')
      } finally {
        queue.length = 0
      }
    },
  }
}
