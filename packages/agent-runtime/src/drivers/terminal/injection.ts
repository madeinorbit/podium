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
 * live SERVER-side today, in `apps/server/src/modules/sessions/inbox.ts` — the
 * bracketed paste, the 90ms CR, the submit-verify retries, the ready-poll drain
 * — while the daemon only writes base64 `input` frames. A driver that lives on
 * the machine cannot wrap code that runs on the server, so the mechanics are
 * PORTED here, over ports, with every constant carried across verbatim.
 *
 * THE CONSTANTS ARE NOT RE-TUNED. Each one below is a measured fact about a
 * shipped CLI's key parser or its startup settle, and re-deriving them from
 * first principles is how a working stack quietly stops working. They are copied
 * with their original names so a diff against `inbox.ts` reads as identity.
 *
 * THE SERVER'S COPY REMAINS AUTHORITATIVE FOR THE FLAG-OFF PATH until W4 retires
 * it. Duplication for one phase is deliberate: the alternative is migrating every
 * caller in the same change that introduces the mechanism, which is the change
 * nobody can review.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A RECEIPT HONEST
 * ---------------------------------------------------------------------------
 *
 * The whole point of routing a send through here is that it comes back with a
 * receipt instead of a hope. Three proofs, in priority order, and a fourth
 * outcome when none of them lands:
 *
 *   1. HOOK — Claude's `UserPromptSubmit` fired for THIS prompt. It is a causal
 *      signal from the harness itself, the same one the reattachment design
 *      anchors turn epochs to, so it is as good as a protocol ack.
 *   2. TRANSCRIPT ECHO — the submitted text appeared as a new user turn in the
 *      harness's own transcript. Weaker (it proves the CLI recorded a turn, not
 *      that this exact keystroke run caused it) but still evidence from the
 *      harness rather than from us.
 *   3. Neither, inside the window ⇒ `unverified`. NOT `refused`, and NOT more
 *      retries: the keystrokes really were delivered, and the caller is told
 *      exactly how long we already waited so the decision is theirs.
 *
 * WHAT IS DELIBERATELY NOT PROOF: the phase leaving `idle`. That is the
 * ready-poll heuristic the whole epic exists to retire — it says the CLI is busy,
 * which a resize, a spinner or somebody else's turn also says. The retry loop
 * still STOPS on it (verbatim from `scheduleSubmitVerify`, because nudging a
 * busy CLI is how a stray CR lands in the composer) but it never upgrades an
 * outcome.
 */

import type { ActingPrincipal, InputOrigin, TurnDelivery, TurnReceipt } from '../../turns.js'

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

/** The bracketed-paste envelope every harness but a cold grok TUI understands. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
export const ESC = '\x1b'

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type TimerHandle = { readonly __timer: unique symbol } | unknown

/**
 * A watch for the causal accept signal.
 *
 * SHAPED AS A PORT SO THE HARNESS IMPORT STAYS DAEMON-SIDE. The fingerprint
 * function is `claudePromptHookFingerprint` in `@podium/harness`, whose consumer
 * set the boundary manifest deliberately restricts; injecting the WATCH rather
 * than importing the fingerprint keeps this package free of it and, more
 * importantly, keeps the hook channel itself — which the contract calls out as
 * "deliberately not in the surface" — inside the driver.
 */
export interface HookAcceptPort {
  /**
   * Begin watching for the accept signal that belongs to `text`, and return a
   * handle. STARTED BEFORE THE FIRST BYTE IS WRITTEN, because a fast CLI can fire
   * `UserPromptSubmit` before the awaiting side gets a turn on the event loop.
   */
  watch(text: string): HookAcceptWatch
}

export interface HookAcceptWatch {
  /** Resolves `true` when the causal accept for this prompt is observed. Never
   *  rejects, and never resolves `false` on its own — the caller's window is
   *  what ends the wait. */
  readonly accepted: Promise<boolean>
  /** Idempotent. A watch nobody cancels is a hook listener that leaks. */
  cancel(): void
}

/** Everything the machine needs from the world, and nothing more. Each one is a
 *  READ or a WRITE on the session's terminal; none of them is a mechanism the
 *  contract exposes. */
export interface TerminalInjectionPorts {
  /** Write UTF-8 text to the session's PTY. The daemon base64-encodes. */
  write(text: string): void
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
  /** USER turns in the harness's own transcript. The submit-verify baseline. */
  userTurnCount(): number
  /** When the PTY last produced output — the drain's quiet detector. */
  lastOutputAtMs(): number
  now(): number
  setTimer(fn: () => void, delayMs: number): TimerHandle
  clearTimer(handle: TimerHandle): void
  /** Absent for harnesses with no causal hook channel; present for Claude. */
  hookAccept?: HookAcceptPort
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
   * THE DRAIN GAVE UP, AND SOMEBODY HAS TO HEAR IT (POD-2107).
   *
   * `QUEUE_DRAIN_DEADLINE_MS` elapsed with the session still not live, so the
   * turns below were never typed. Until this port existed that outcome made no
   * sound at all: `stop()` set a boolean, the caller kept a receipt that said
   * `queued`, and the only way to find out was to notice that an answer never
   * came. A queue whose failure mode is invisible is the POD-549 loss wearing a
   * durable row's clothes, and this is the seam that ends the silence.
   *
   * THE TURNS ARE STILL QUEUED when this fires — nothing is shifted. The report
   * is "not delivered inside the deadline", not "discarded": a later enqueue
   * restarts the drain and takes these turns first, which is why the deadline is
   * `retryable` rather than terminal. A consumer that wants to correct its own
   * receipt has what it needs; one that does not is unchanged.
   */
  onDrainAbandoned?(turns: readonly QueuedTurn[], reason: 'never-live'): void
}

export interface DeliverOptions {
  origin: InputOrigin
  /** `when-ready` and `interrupt` reach here; `queue` is the queue below and
   *  `steer` has already been downgraded to it by the caller. */
  delivery: Extract<TurnDelivery, 'when-ready' | 'interrupt'>
  /** Set by the interrupt path: an ESC already went out, so the `needs_user`
   *  refusal below does not apply (the ESC is what clears the prompt). */
  afterEsc?: boolean
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
  /** REQUEST a fence: one ESC, and nothing else. The fence itself only ever
   *  arrives as a provider-confirmed terminal event on the causal stream. */
  interrupt(): void
  /** Open queue depth, for `snapshot()` and diagnostics. */
  queueDepth(): number
  /** Stop every timer this machine owns (session teardown). */
  dispose(): void
}

export function createTerminalInjection(ports: TerminalInjectionPorts): TerminalInjectionMachine {
  const queue: QueuedTurn[] = []
  const timers = new Set<TimerHandle>()
  let draining = false
  /** Driver-local turn counter. See `nextTurnEpoch`. */
  let localTurnEpoch = 0
  let disposed = false

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

  /**
   * The ported `scheduleSubmitVerify` ladder, plus the echo watch that turns it
   * into evidence instead of a nudge.
   *
   * Returns the proof that landed, or null when the window closed without one.
   */
  async function awaitProof(
    baselineUserTurns: number,
    hookWatch: HookAcceptWatch | undefined,
  ): Promise<'hook' | 'transcript-echo' | null> {
    let hookFired = false
    void hookWatch?.accepted.then((ok) => {
      hookFired = hookFired || ok
    })
    let retriesLeft = ports.needsSubmitVerification() ? SUBMIT_MAX_RETRIES : 0
    let nudging = true
    const deadline = ports.now() + VERIFICATION_WINDOW_MS

    while (ports.now() < deadline) {
      // Race the hook against the tick so a causal accept is not made to wait out
      // a 1.6s poll it already answered.
      const tick = sleep(SUBMIT_VERIFY_DELAY_MS)
      await (hookWatch ? Promise.race([hookWatch.accepted, tick]) : tick)
      if (hookFired) return 'hook'
      if (ports.userTurnCount() > baselineUserTurns) return 'transcript-echo'
      // A dead session cannot echo and cannot be nudged. Stop; the caller gets
      // `unverified`, which is the truth: the bytes went out, nothing confirmed.
      if (!ports.running()) return null
      const phase = ports.phase()
      // VERBATIM from `scheduleSubmitVerify`: a CLI that has left idle is busy,
      // and a stray CR into a busy composer is its own bug. Stop NUDGING — but
      // keep watching, because the echo may still be a moment away.
      if (phase !== undefined && phase !== 'idle') nudging = false
      if (nudging && retriesLeft > 0) {
        retriesLeft -= 1
        ports.write('\r')
      }
    }
    return hookFired ? 'hook' : null
  }

  async function deliver(text: string, options: DeliverOptions): Promise<TurnReceipt> {
    if (!ports.running()) {
      return { outcome: 'refused', refusal: { reason: 'not_running' } }
    }
    // ONE OF EXACTLY TWO REFUSALS THE TERMINAL PATH HAS TODAY (inbox.ts ~713).
    // An open native prompt swallows a paste, so typing into it is not delivery.
    // The interrupt path is exempt because its ESC is what dismisses the prompt.
    if (!options.afterEsc && ports.phase() === 'needs_user') {
      return {
        outcome: 'refused',
        refusal: { reason: 'needs_user', detail: 'a native prompt is open' },
      }
    }

    const baseline = ports.userTurnCount()
    // Started BEFORE the write: a fast CLI can fire `UserPromptSubmit` before we
    // would otherwise be listening, and a proof we missed reads as `unverified`.
    const hookWatch = ports.hookAccept?.watch(text)
    try {
      const payload = ports.rawFirstTurn() ? text : `${PASTE_START}${text}${PASTE_END}`
      ports.write(payload)
      setTimer(() => {
        if (ports.running()) ports.write('\r')
      }, SUBMIT_CR_DELAY_MS)

      const proof = await awaitProof(baseline, hookWatch)
      if (!proof) {
        return {
          outcome: 'unverified',
          deliveredAs: options.delivery,
          verificationWindowMs: VERIFICATION_WINDOW_MS,
          at: new Date(ports.now()).toISOString(),
        }
      }
      return {
        outcome: 'accepted',
        turnEpoch: nextTurnEpoch(),
        deliveredAs: options.delivery,
        provenBy: proof,
        at: new Date(ports.now()).toISOString(),
      }
    } finally {
      hookWatch?.cancel()
    }
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
      void deliver(head.text, { origin: head.origin, delivery: 'when-ready' }).then((receipt) => {
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
        // exactly what is still undelivered.
        ports.onDrainAbandoned?.([...queue], 'never-live')
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
      ports.write(ESC)
    },
    queueDepth: () => queue.length,
    dispose() {
      disposed = true
      for (const handle of timers) ports.clearTimer(handle)
      timers.clear()
      queue.length = 0
    },
  }
}
