/**
 * A LOG LINE THAT WOULD REPEAT ONCE PER ITEM OF A BURST (POD-7036).
 *
 * Some debug lines fire once per session a pass touches: "session ownership
 * registry miss" and "session materialized" were 200k and 89k lines in six days
 * on the live server (the POD-7027 audit's finding 11), the same few hundred
 * sessions over and over. The line is still worth having: it is how a miss
 * burst is found. So the first `burst` lines of each window are written as
 * before, the rest of the window is counted, and the next line written carries
 * that count as `suppressed`, so the total is never lost.
 */
export class LogRate {
  private windowStartedAt = Number.NEGATIVE_INFINITY
  private written = 0
  private suppressed = 0

  constructor(
    private readonly windowMs = 60_000,
    private readonly burst = 20,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether to write this line. When it says yes, the fields to add to it:
   * `{ suppressed }` with the number of lines held back since the last one
   * written, or nothing.
   */
  take(): { suppressed?: number } | undefined {
    const at = this.now()
    if (at - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = at
      this.written = 0
    }
    if (this.written >= this.burst) {
      this.suppressed += 1
      return undefined
    }
    this.written += 1
    if (this.suppressed === 0) return {}
    const fields = { suppressed: this.suppressed }
    this.suppressed = 0
    return fields
  }
}
