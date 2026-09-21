/**
 * THE SHELL LIFETIME POLICY (POD-4435): one server-side rule decides whether a
 * shell is kept, parked or killed, from who owns it and whether it was used —
 * instead of a quiet-time timer.
 *
 * A shell's lifetime is an ownership question, not a quietness one. The policy
 * takes the owning issue/worktree state, whether any tab holds the shell,
 * whether it has ever received input, whether a viewer renders it (nativeView,
 * for attach TUIs), and quiet time only as a last resort — and answers one
 * verb: keep, park or kill. It replaces the shell branch of the idle reaper
 * AND the attach-TUI warm-park TTL, which were two unrelated decisions about
 * the same question.
 *
 * THE TABLE (first match wins):
 *
 * | # | condition                                              | verdict |
 * |---|--------------------------------------------------------|---------|
 * | 1 | process already gone                                   | keep    |
 * | 2 | purpose is login (kept until exit)                     | keep    |
 * | 3 | quiet past the multi-day backstop (last resort)        | kill    |
 * | 4 | attach TUI unwatched past its warm TTL                 | park    |
 * | 5 | untouched + this evaluation answers a tab-close release| kill    |
 * | 6 | untouched + unheld past the idle grace                 | kill    |
 * | 7 | touched + owning issue closed or worktree freed        | park    |
 * | 8 | untouched + unheld + owning issue closed/freed         | kill    |
 * | 9 | otherwise (durable by default)                         | keep    |
 *
 * VOCABULARY (daemon park/kill vs server park/kill): on the daemon, park drops
 * the Terminal and keeps the process while kill disposes the process. On the
 * server, park kills the process but keeps the row inspectable (hibernated — a
 * fresh spawn in the same cwd IS full recovery for a shell), while kill
 * tombstones the row too. The verbs below are the server ones; each trigger
 * maps them onto its mechanism verbs (see the trigger notes).
 *
 * TRIGGERS (one call site of decideShellLifetime each):
 * - tab release: the client sends an explicit release when its last tab for
 *   the shell closes. A dropped WebSocket sends nothing, so a network blip is
 *   never a release; the release maps park to nothing (a release never parks —
 *   a touched shell simply stays).
 * - reaper tick: evaluates every live shell. Never kills on the level alone
 *   except through rows 3 and 6 (the backstop and the unheld grace, both far
 *   beyond any blip); maps all three verbs directly.
 * - issue close / worktree free: evaluates with the owner gone. An explicit
 *   close always stops what it finds, so the trigger maps keep to the existing
 *   stop (park) — the table's keep answers the passive question ("would the
 *   policy park this on its own?"), not whether an explicit close may stop it.
 *
 * `lastTabReleased` is an EVENT EDGE, not a level: it is true only while
 * answering the explicit release. `heldByTab` is the level (any connected
 * client still rendering or streaming the shell, excluding the reporter on the
 * release path). `unheldMs` is how long nothing has held it (unknown reads as
 * absent and disables row 6 — a blip must never look like abandonment).
 *
 * The shell-to-worktree mapping is deliberately NOT built here (separate
 * issue): callers pass the issue id / cwd the row already has as issueClosed /
 * worktreeFreed levels.
 */

export type ShellLifetimeVerdict = 'keep' | 'park' | 'kill'

export type ShellLifetimePurpose = 'shell' | 'login' | 'attach-tui'

export interface ShellLifetimeInputs {
  /** No per-kind branches: a dock shell, a tab shell, a login pane and an
   *  attach TUI all go through this table; purpose is the one discriminator. */
  purpose: ShellLifetimePurpose
  /** Whether the shell ever received input (`last_input_at` is non-null). */
  hasInput: boolean
  /** Whether any tab still holds the shell (rendering or streaming it). */
  heldByTab: boolean
  /** Whether a viewer renders it right now (nativeView — the attach-TUI input). */
  watched: boolean
  /** True only while answering an explicit tab-close release. Never true for a
   *  disconnect: a dropped WebSocket sends no release. */
  lastTabReleased: boolean
  /** Whether the owning issue is closed (false when the shell has no issue). */
  issueClosed: boolean
  /** Whether the owning worktree was freed. */
  worktreeFreed: boolean
  /** Ms since the shell's last activity. Last resort only (row 3). */
  quietMs: number
  /** Ms since anything held the shell. Absent (unknown) disables row 6. */
  unheldMs?: number | undefined
  /** Ms since a viewer last rendered the attach TUI. */
  unwatchedMs: number
  /** The attach-TUI warm-park TTL (the daemon's WARM_TTL_MS). */
  warmTtlMs: number
  /** The multi-day last resort. Absent disables row 3. */
  backstopMs?: number | undefined
  /** The idle grace for untouched, unheld shells. Absent disables row 6. */
  idleGraceMs?: number | undefined
  /** The process is already gone: there is nothing to park or kill. */
  exited: boolean
}

export interface ShellLifetimeDecision {
  verdict: ShellLifetimeVerdict
  /** Stable kebab-case reason, for logs and tests. */
  reason: string
}

/**
 * Ms since the shell's last activity, in the vocabulary every trigger shares:
 * the max over event-time and terminal stamps. Malformed stamps read as zero
 * (a shell that cannot prove quiet is not quiet) — protection by default.
 */
export function shellQuietMs(
  nowMs: number,
  stamps: { lastActiveAt: string; lastResumedAtMs: number; lastInputAtMs: number; lastOutputAtMs: number },
): number {
  const parsed = [
    Date.parse(stamps.lastActiveAt),
    stamps.lastResumedAtMs,
    stamps.lastInputAtMs,
    stamps.lastOutputAtMs,
  ]
  if (!parsed.every(Number.isFinite)) return 0
  return Math.max(0, nowMs - Math.max(...parsed))
}

export function decideShellLifetime(input: ShellLifetimeInputs): ShellLifetimeDecision {
  // Row 1: nothing to decide for a shell with no process.
  if (input.exited) return { verdict: 'keep', reason: 'already-exited' }
  // Row 2: the login exemption, expressed as one line in the table instead of
  // a protection flag checked beside the policy.
  if (input.purpose === 'login') return { verdict: 'keep', reason: 'login-pane-kept-until-exit' }
  // Row 3: quiet time is the LAST resort, never the criterion.
  if (input.backstopMs !== undefined && input.quietMs >= input.backstopMs) {
    return { verdict: 'kill', reason: 'multi-day-backstop' }
  }
  // Row 4: the attach-TUI warm-park TTL, as an input to this table rather than
  // a second decision elsewhere. Park drops the TUI's Terminal; the process
  // stays owned until a kill verdict.
  if (
    input.purpose === 'attach-tui' &&
    !input.watched &&
    input.unwatchedMs >= input.warmTtlMs
  ) {
    return { verdict: 'park', reason: 'attach-tui-unwatched-past-warm-ttl' }
  }
  // Row 5: an untouched shell dies when its tab closes — immediately, on the
  // explicit release edge, and only when nothing else holds it (no
  // cross-client kill while another tab renders it).
  if (!input.hasInput && input.lastTabReleased && !input.heldByTab) {
    return { verdict: 'kill', reason: 'untouched-shell-last-tab-released' }
  }
  // Row 6: the same death without the edge, for releases the server never saw
  // (the browser closed with the tab still open). The grace is measured in
  // UNHELD time, not quiet time, so a network blip — seconds of unheld inside
  // a held shell — can never trip it.
  if (
    !input.hasInput &&
    !input.heldByTab &&
    input.idleGraceMs !== undefined &&
    input.unheldMs !== undefined &&
    input.unheldMs >= input.idleGraceMs
  ) {
    return { verdict: 'kill', reason: 'untouched-shell-unheld-past-grace' }
  }
  // Row 7: durable by default — a shell that received input is parked, not
  // killed, when its owner goes away.
  if (input.hasInput && (input.issueClosed || input.worktreeFreed)) {
    return { verdict: 'park', reason: 'touched-shell-owner-gone' }
  }
  // Row 8: nothing was ever typed and the owner is gone — no row worth keeping.
  if (!input.hasInput && !input.heldByTab && (input.issueClosed || input.worktreeFreed)) {
    return { verdict: 'kill', reason: 'untouched-shell-owner-gone' }
  }
  // Row 9: durable by default — a used shell stays with its issue.
  return { verdict: 'keep', reason: 'durable-by-default' }
}
