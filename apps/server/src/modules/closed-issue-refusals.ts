/**
 * WHICH REFUSED CLOSED ISSUES THE SWEEP LEAVES ALONE, AND FOR HOW LONG
 * (POD-7036, the POD-7027 audit's finding 8).
 *
 * The closed-issue sweep asked every closed issue with work left to stop its
 * sessions, every 15 minutes, forever. A worktree with unsaved changes refuses
 * that stop, and nothing about it changes until a person looks at it: over six
 * days the live server asked 276 issues about 1,146 times each, logged 77.6k
 * "stop requested" and 29.0k "refused" lines, and every one of those asks
 * re-read the issue, restored its parked sessions and asked the daemon for a
 * `git status`.
 *
 * A REFUSAL IS REMEMBERED WITH ITS FINGERPRINT: the refusal text, which names
 * the dirty files (`git status` lines) or the inspection error. The same
 * refusal again doubles the number of passes the issue sits out, up to
 * {@link CLOSED_ISSUE_MAX_BACKOFF_PASSES} (a day at 15 minutes). A different
 * refusal is a change, so the wait starts over and it is logged; a repeat is
 * not logged. A stop that goes through forgets the issue.
 *
 * WHAT FORGETS AN ENTRY, so a real change still gets through:
 *   - the stop succeeding (the sweep or the close itself);
 *   - the issue leaving the sweep's candidate set (reopened, worktree freed,
 *     every member parked): `retain` drops it at the start of each pass;
 *   - a close of the issue: the close always runs, whatever this says, and its
 *     outcome replaces the entry;
 *   - a server restart: this is process memory, and the startup pass asks
 *     every candidate once.
 * A change the sweep cannot see (a person commits the dirty files) waits at
 * most one capped back-off; the explicit `podium issue stop` path never reads
 * this.
 *
 * BOUNDED by the sweep's candidate set (closed issues with a worktree or an
 * unparked member), which `retain` prunes to on every pass. This is live
 * runtime state (when to ask again), not a copy of any table.
 */

/** The most passes a refused issue sits out between asks: a day at 15 minutes. */
export const CLOSED_ISSUE_MAX_BACKOFF_PASSES = 96

/** The most closed issues one sweep pass asks to stop. The rest wait their turn. */
export const CLOSED_ISSUE_SWEEP_MAX_PER_PASS = 25

interface Refusal {
  /** The refusal text it was last refused with. */
  fingerprint: string
  /** How many times in a row it was refused with that text. */
  repeats: number
  /** The first pass that may ask it again. */
  dueAtPass: number
}

export class ClosedIssueRefusals {
  private readonly refused = new Map<string, Refusal>()
  private pass = 0

  /** Start a pass: drop every issue no longer a candidate, then pick the ones due.
   *  Issues never refused go first, in the candidates' order; refused ones that
   *  are due follow, longest-waiting first. At most `limit` are returned. */
  beginPass<T extends string>(
    candidates: readonly T[],
    limit = CLOSED_ISSUE_SWEEP_MAX_PER_PASS,
  ): T[] {
    this.pass += 1
    this.retain(candidates)
    const fresh: T[] = []
    const due: T[] = []
    for (const id of candidates) {
      const refusal = this.refused.get(id)
      if (!refusal) fresh.push(id)
      else if (refusal.dueAtPass <= this.pass) due.push(id)
    }
    due.sort(
      (a, b) => (this.refused.get(a)?.dueAtPass ?? 0) - (this.refused.get(b)?.dueAtPass ?? 0),
    )
    return [...fresh, ...due].slice(0, limit)
  }

  /** Forget every issue that is not among `candidates`. */
  retain(candidates: readonly string[]): void {
    const keep = new Set(candidates)
    for (const id of this.refused.keys()) if (!keep.has(id)) this.refused.delete(id)
  }

  /** The stop went through: ask it again whenever it is a candidate. */
  succeeded(issueId: string): void {
    this.refused.delete(issueId)
  }

  /**
   * The stop was refused with `fingerprint`. Returns whether this refusal is a
   * CHANGE (new, or different from the last one) and so worth logging.
   */
  refusedWith(issueId: string, fingerprint: string): boolean {
    const prior = this.refused.get(issueId)
    const changed = prior?.fingerprint !== fingerprint
    const repeats = changed ? 1 : (prior?.repeats ?? 0) + 1
    // 1, 3, 7, 15, … passes sat out, capped.
    const wait = Math.min(2 ** repeats - 1, CLOSED_ISSUE_MAX_BACKOFF_PASSES)
    this.refused.set(issueId, { fingerprint, repeats, dueAtPass: this.pass + wait + 1 })
    return changed
  }

  /** How many issues are remembered as refused (tests and diagnostics). */
  get size(): number {
    return this.refused.size
  }
}
