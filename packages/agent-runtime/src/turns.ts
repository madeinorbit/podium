// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { Declared } from '@podium/harness'
import type { SessionId } from '@podium/model'
import type { ObservationInputOrigin } from '@podium/protocol'

// ---------------------------------------------------------------------------
// Turns and control — the one write path (spec §3)
// ---------------------------------------------------------------------------

/** How a send should reach the agent. `steer` appends into an OPEN turn where
 *  the harness supports it (Codex `turn/steer`); embedded and terminal degrade
 *  to `queue` and the receipt REPORTS the downgrade. */
export type TurnDelivery = 'when-ready' | 'queue' | 'interrupt' | 'steer'

/** Who is writing. Chat, mail, steward, superagent and auto-continue all become
 *  callers of one verb with different origins — this replaces `typeText` /
 *  `queueText` / `sendTextWhenReady` / `interruptText`. */
export type InputOrigin = ObservationInputOrigin

export interface TurnInput {
  /**
   * Stable identity supplied by the caller when a later delivery outcome has
   * to reconcile durable state outside the driver. Drivers must carry it
   * through any local queue unchanged.
   *
   * OPTIONAL, AND ABSENT MEANS ABSENT. No driver mints a fallback — terminal
   * takes `options.id` as given and the server families carry `input.id`
   * through untouched — so a turn can reach a driver queue with no identity at
   * all, and the machinery downstream is built for that: an abandonment report
   * carries such a turn anyway, and the daemon logs it as `unattributed`
   * rather than inventing an id the server would fail to find a row for.
   * A turn with no id is therefore never SILENTLY lost, but it is also never
   * receipt-corrected.
   *
   * THE WRITE PATH IS AT-LEAST-ONCE, AND THIS ID IS WHAT MAKES THAT SURVIVABLE
   * (POD-2297). A send whose outcome is UNKNOWN — an `unverified` receipt, an
   * RPC window that closed with no daemon reply — leaves the caller's durable
   * row queued, and the next bind, reconnect or enqueue re-sends it under this
   * same id. So a turn that WAS delivered but could not be proven is delivered
   * TWICE. That is the deliberate direction: under a two-generals gap a
   * duplicate prompt is something a reader can recover from and a vanished one
   * is not.
   *
   * TWO DIFFERENT DUPLICATES HIDE UNDER THAT SENTENCE, and only one of them is
   * anybody's to dedupe (POD-2297 review, E2):
   *
   *  - THE OUTCOME duplicate — the same delivery outcome observed twice, e.g.
   *    an abandonment report replayed until acknowledged. It CARRIES this id,
   *    so it is dedupable, and handlers of those outcomes must be IDEMPOTENT
   *    UNDER REPEATS. Idempotent, not necessarily deduplicating: the server's
   *    status writes are guarded on `status = 'queued'` and are therefore safe
   *    however often they are replayed, while append-only observation events
   *    (`reconcileReceipt`'s per-receipt transitions) legitimately emit once
   *    per occurrence and are exempt.
   *  - THE PROMPT duplicate — the agent seeing the same words twice in its own
   *    provider transcript, which is the visible harm the paragraph above
   *    describes. Those turns carry PROVIDER ids and no `turnId`, so nothing
   *    downstream can pair them and no consumer-side fix exists. That residual
   *    belongs to POD-2497, and closing it for good needs a durable
   *    idempotency key on the server's inbox drain, not driver-local memory.
   *
   * No driver may claim exactly-once on the strength of this id: driver-local
   * memory dies with the process, so dedupe there narrows the window and never
   * closes it.
   */
  id?: string
  text: string
  /** Refs minted by `stageAttachment` — already landed on the session's machine
   *  in the form the harness accepts. */
  attachments?: readonly AttachmentRef[]
  /** Applies to THIS TURN ONLY. Session-sticky changes go through `configure()`;
   *  the split is a spec rule, not a convention. */
  overrides?: Declared<{ model?: string; effort?: string }>
}

export type AttachmentKind = 'image' | 'file'

export interface AttachmentSource {
  bytes: Uint8Array
  filename: string
  mediaType: string
}

export interface AttachmentRef {
  id: string
  /** Where it landed on the session's machine. */
  path: string
  filename: string
  mediaType: string
  kind: AttachmentKind
}

export type AttachmentStageResult = AttachmentRef | Refusal
export type AttachmentStager = (input: {
  sessionId: SessionId
  source: AttachmentSource
}) => Promise<AttachmentRef>

/**
 * WHO IS ACTING — carried through queueing so a deferred turn can still be
 * authorized as its real sender (POD-1761 W3 review, F3).
 *
 * OPAQUE ON PURPOSE. The contract does not parse `ref` and does not know what a
 * principal MEANS: authorization lives on the server, whose own principal record
 * is richer than anything a driver should see (attribution, delegation chain,
 * on-behalf-of). What the contract guarantees is only that the value the caller
 * handed to `send()` is the value that reaches the point where the decision is
 * made — because the alternative, which W3 shipped and its review caught, is a
 * queue that re-authorizes every deferred turn as a system default and thereby
 * grants it privileges its sender never had.
 *
 * `kind` is here and not opaque because a receipt and an interaction answer both
 * need to say what KIND of party acted without decoding a ref they cannot parse.
 */
export interface ActingPrincipal {
  readonly kind: 'user' | 'agent' | 'system'
  /** An id in the composer's own namespace. Compared, logged and carried —
   *  never interpreted. */
  readonly ref: string
}

export interface SendOptions {
  origin: InputOrigin
  delivery: TurnDelivery
  /**
   * The party this send is on behalf of.
   *
   * OPTIONAL AT THE TYPE LEVEL, and that is a migration affordance rather than a
   * blessing: a `queue` whose principal is absent is authorized as whatever the
   * composer's default is, which is exactly the weakness this field exists to
   * close. Every caller W4 migrates must pass it.
   */
  principal?: ActingPrincipal
}

/** Options for `answer()`. Same acting principal as a send, for the same reason:
 *  an answer typed into a native menu is an ACTION, and the event it produces
 *  claims who took it. */
export interface AnswerOptions {
  principal?: ActingPrincipal
}

/**
 * WHY A SEND CAN BE REFUSED. A refusal is SYNCHRONOUS and EXPECTED — a typed
 * reply to a verb, not an error. The caller handles it; nothing is "wrong".
 */
export type RefusalReason =
  /** An open interaction blocks the write until it is answered. */
  | 'needs_user'
  /** A human holds the control lease in take-over mode. Headless drivers queue
   *  rather than interleave — exactly what `queueText` does today. */
  | 'lease_held'
  /** `Declared<T>` says this driver does not implement the verb. */
  | 'unsupported'
  /** `hibernate()` without a resume ref: hibernating would lose the session. */
  | 'no_resume_ref'
  /** The session reached a terminal lifecycle phase. */
  | 'session_ended'
  /** No live process. `adopt()` or `resume()` first. */
  | 'not_running'
  /** The driver supports staging, but the machine could not persist the bytes. */
  | 'staging_failed'
  /** A turn is open and the requested delivery cannot join it. */
  | 'busy'
  /**
   * THE VERB IS IMPLEMENTED AND ITS PRECONDITION IS NOT MET YET (POD-2703).
   *
   * `export()` against a harness that has not written its session store — the
   * driver reads the harness's own files, and a session that has not spoken has
   * none. The SAME session answers after a turn.
   *
   * NOT `unsupported`, and the difference is the only thing either reason is
   * for: a caller retries this one and never that one. Typing a not-yet as
   * permanent is worse than leaving it untyped, because the caller now trusts a
   * wrong answer and stops retrying something that would have succeeded.
   */
  | 'no_archive_yet'

export interface Refusal {
  reason: RefusalReason
  /** Harness-specific detail, preserved for diagnostics. Never parsed for
   *  control flow — that is what `reason` is for. */
  detail?: string
}

/**
 * THE FOUR OUTCOMES. `send` resolves to exactly one of these — the spec's
 * central honesty commitment.
 *
 * `unverified` IS THE TWO-GENERALS GAP MADE EXPLICIT instead of retried into a
 * lie. The keystrokes were delivered but acceptance could not be proven inside
 * the verification window. Callers decide what to do (retry, surface, wait for
 * the transcript echo) WITH THE TRUTH IN HAND. It is terminal-family only, and
 * the conformance suite's permitted-failures table is what says so.
 */
export type TurnReceipt =
  | {
      outcome: 'accepted'
      /** The turn that opened. Callers correlate subsequent events by it. */
      turnEpoch: number
      /** The delivery ACTUALLY used. Differs from the requested one when a
       *  driver degraded `steer` → `queue`; never a silent substitution. */
      deliveredAs: TurnDelivery
      /** What proved acceptance. For server/embedded this is the protocol ack;
       *  for terminal it is a causal hook where one exists (Claude's
       *  `UserPromptSubmit`) and submit-verification otherwise. */
      provenBy: SendProof
      at: string
    }
  | {
      outcome: 'queued'
      /** Durable position in the queue. */
      position: number
      deliveredAs: TurnDelivery
      at: string
    }
  | { outcome: 'refused'; refusal: Refusal }
  | {
      outcome: 'unverified'
      deliveredAs: TurnDelivery
      /** How long the driver waited for proof before saying so. */
      verificationWindowMs: number
      at: string
    }

/** What proved a send was accepted — the declared mechanism behind rule 2's
 *  family-invariant guarantee. */
export type SendProof =
  /** A protocol acknowledgement (Codex `turn/started`, opencode's message ack). */
  | 'protocol-ack'
  /** An SDK callback returned. */
  | 'sdk-callback'
  /** A causal hook fired — Claude's `UserPromptSubmit`, the same signal the
   *  reattachment design anchors turn epochs to. */
  | 'hook'
  /** The submitted text appeared in the transcript within the window. */
  | 'transcript-echo'
