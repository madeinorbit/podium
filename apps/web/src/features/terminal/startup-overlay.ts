/**
 * WHAT THE PANEL SHOWS OVER A TERMINAL THAT HAS PAINTED NOTHING (POD-385).
 *
 * The panel used to have one boot state — "Starting…", dropped the instant the
 * server confirmed the attach. That is the right moment for a session idling at
 * a prompt (POD-379: attached, screen unknown, nothing more to wait for), and
 * the wrong one for a child that has genuinely printed NOTHING yet: grok
 * self-updating on launch left a measured FOUR MINUTES of blank PTY, which is
 * pixel-identical to a dead session.
 *
 * So there are two waits, not one, and the difference is a fact the server
 * reports at attach (`outputSeen`, from the durable output counter) rather than
 * anything guessed from an empty screen:
 *
 * | state      | when                                    | shows |
 * |------------|-----------------------------------------|-------|
 * | `starting` | not attached yet                        | spinner + "Starting <agent>…" |
 * | `stalled`  | still not attached, long past any launch | no spinner — the wait is named |
 * | `silent`   | attached, PTY silent since spawn        | the same, plus how long it has been quiet |
 * | `hidden`   | output has landed                       | the terminal itself |
 *
 * NOTHING HERE KNOWS ABOUT ANY HARNESS. "Has this PTY ever spoken" is asked of
 * every session the same way; a CLI that updates itself on first launch is just
 * the loudest case of it.
 *
 * `stalled` EXISTS BECAUSE `starting` HAD NO EXIT (POD-2290). Every other state
 * here resolves: `silent` is measurably attached and counts its own wait, and
 * `hidden` is the terminal. `starting` alone could run forever — a spawn that
 * failed before its session row ever reconciled leaves a spinner that is
 * pixel-identical to a launch still in progress, with no elapsed line and (no
 * row ⇒ nothing known to be chat-capable) no view switch to escape through.
 * A spinner is a claim that something is happening; past the point where that
 * claim can still be true it has to stop being made.
 */

/**
 * How long a silent PTY stays plainly "Starting…" before the panel starts
 * saying how long it has been quiet. A normal launch paints within a few
 * hundred ms, and a counter that appears only to be retracted a tick later
 * reads as a glitch — so the elapsed line is reserved for a wait that has
 * already outlasted every healthy start.
 */
export const SILENCE_ELAPSED_AFTER_MS = 3_000

/**
 * When a quiet start stops being merely slow and earns a sentence explaining
 * it. Deliberately generic: the panel cannot know WHY a child is quiet, only
 * that it is, and the honest reading of a long silence is "still working on
 * something it hasn't printed".
 */
export const SILENCE_HINT_AFTER_MS = 20_000

/**
 * How long a mount waits for its attach before the spinner is retired for the
 * {@link StartupOverlay} `stalled` state.
 *
 * Generous on purpose, and measured against the wrong thing being cheap in only
 * one direction: an attach that is merely slow (a daemon reconnecting, a
 * machine under load) recovers on its own and a premature "this isn't working"
 * would be a lie about a session that is fine. Nothing is lost by waiting —
 * the screen is a spinner either way — so this sits well past every attach that
 * has ever landed rather than at the edge of the common case.
 */
export const ATTACH_STALLED_AFTER_MS = 45_000

export type StartupOverlay =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'awaiting-machine'
      /** ms this mount has been looking at a session whose machine is away. */
      readonly elapsedMs: number
    }
  | {
      readonly kind: 'stalled'
      /** ms this mount has been waiting for its attach. */
      readonly elapsedMs: number
    }
  | {
      readonly kind: 'silent'
      /** ms the PTY has been silent, once past {@link SILENCE_ELAPSED_AFTER_MS};
       *  null while too early to show, or when the spawn time is unknown. */
      readonly elapsedMs: number | null
      /** Past {@link SILENCE_HINT_AFTER_MS}: explain the wait. */
      readonly hint: boolean
    }

export function startupOverlay(input: {
  /** The mount is usable — the attach is confirmed (or its backstop fired). */
  readonly ready: boolean
  /** The PTY has produced output at some point since it was spawned. */
  readonly outputSeen: boolean
  /** How long the session has existed, in ms — the best available stand-in for
   *  "how long the child has been quiet", since a silent session has printed
   *  nothing to date it by. Null when the session row hasn't arrived yet. */
  readonly ageMs: number | null
  /**
   * How long THIS MOUNT has been waiting for its attach, in ms. Null when it is
   * not waiting (or the caller cannot date the wait).
   *
   * DELIBERATELY NOT `ageMs`. The session's age dates the CHILD; this dates the
   * attach, and they are different clocks — opening a panel on a session that
   * has been running for an hour starts a wait of zero, and reading its age
   * would declare the attach stalled before it was even issued.
   */
  readonly attachWaitMs: number | null
  /**
   * How long this mount has been looking at a session whose MACHINE has not
   * checked in — and only when nothing has said what kind of session it is.
   * Null the rest of the time, which is almost always.
   *
   * THE SEAM ROUND TWO MISSED, found by driving it (POD-2290). A server restart
   * rehydrates live rows as `reconnecting`, and the reviewer held the daemon
   * down and watched a headless session sit on "Starting OpenCode… / no output
   * yet · 4:35 / Still attached — some CLIs update themselves…". Every clause of
   * that is false: nothing is starting, nothing is attached, and the reason is
   * neither the harness nor the session. The `stalled` clock could not rescue it
   * because the attach HAD confirmed — the server answers it without the daemon
   * — so `ready` was true and the wait fell into `silent`, which has no exit.
   *
   * Scoped to family-unknown by the caller, deliberately: a row that carries its
   * driver family has nothing to be confused about, and every row written after
   * that fact became durable carries one. What lands here is the legacy tail.
   */
  readonly awaitingMachineMs: number | null
}): StartupOverlay {
  const awaiting =
    input.awaitingMachineMs !== null && input.awaitingMachineMs >= ATTACH_STALLED_AFTER_MS
      ? input.awaitingMachineMs
      : null
  if (!input.ready) {
    // The machine's absence outranks the attach's: it explains the attach, and
    // "this isn't working" is a worse answer than "we haven't heard from the
    // machine" when the second one is the actual cause.
    if (awaiting !== null) return { kind: 'awaiting-machine', elapsedMs: awaiting }
    const waited = input.attachWaitMs
    if (waited !== null && waited >= ATTACH_STALLED_AFTER_MS) {
      return { kind: 'stalled', elapsedMs: waited }
    }
    return { kind: 'starting' }
  }
  // A terminal that has painted keeps its screen even when the machine goes
  // away — the last frame is still the truest thing to show — so `hidden` is
  // checked before the machine's absence, not after.
  if (input.outputSeen) return { kind: 'hidden' }
  if (awaiting !== null) return { kind: 'awaiting-machine', elapsedMs: awaiting }
  const age = input.ageMs
  if (age === null || age < SILENCE_ELAPSED_AFTER_MS) {
    return { kind: 'silent', elapsedMs: null, hint: false }
  }
  return { kind: 'silent', elapsedMs: age, hint: age >= SILENCE_HINT_AFTER_MS }
}

/**
 * Age of a session in ms against a client clock. Clamped at zero: `createdAt`
 * is the SERVER's timestamp and the browser's clock can sit behind it, which
 * would otherwise render a negative wait.
 */
export function sessionAgeMs(createdAt: string | undefined, nowMs: number): number | null {
  if (createdAt === undefined) return null
  const started = Date.parse(createdAt)
  if (Number.isNaN(started)) return null
  return Math.max(0, nowMs - started)
}
