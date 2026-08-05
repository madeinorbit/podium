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
 * | `silent`   | attached, PTY silent since spawn        | the same, plus how long it has been quiet |
 * | `hidden`   | output has landed                       | the terminal itself |
 *
 * NOTHING HERE KNOWS ABOUT ANY HARNESS. "Has this PTY ever spoken" is asked of
 * every session the same way; a CLI that updates itself on first launch is just
 * the loudest case of it.
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

export type StartupOverlay =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'starting' }
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
}): StartupOverlay {
  if (!input.ready) return { kind: 'starting' }
  if (input.outputSeen) return { kind: 'hidden' }
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
