/**
 * THE FOREIGN-WRITE COUNTER (POD-4888, receipt-proof spec §5.3).
 *
 * One per session, owned by the session entry, and bumped from exactly one
 * place: the {@link Terminal} write call, which every byte the daemon puts into
 * a session's terminal passes through (`terminal-write-guard.test.ts` keeps it
 * that way). It counts every write that is NOT part of the message being typed
 * — a person's keystrokes, menu answers, interrupt keys, clears, redraws, Draft
 * Sync, anything — and every moment this daemon stopped being the only possible
 * writer: a lost writer lease, a detach, a (re)attach.
 *
 * What it is for: a person's own words carry no id into a terminal agent's
 * history, so the next prompt entry after a message's position may be credited
 * to it by ORDER only while nothing else could have submitted anything. "The
 * counter did not move between the start of typing and the read" is that fact.
 *
 * It only observes. Every method is a synchronous O(1) field update (the typing
 * marks are a bounded map), so no write is ever delayed or refused by it.
 *
 * Counts WRITES, not bytes and not Enters: a write is the unit a foreign actor
 * can interleave, and parsing for Enter would be a guess about what the program
 * treats as a submit.
 */

/**
 * The tag a message's OWN writes carry — its paste, its Enter and its submit
 * retries — so the counter lets them through uncounted. Exported to the one
 * caller that types messages (`runtime/host.ts`, the harness terminal
 * driver's transport); the write guard
 * test pins that nothing else uses it.
 */
export const MESSAGE_WRITE: unique symbol = Symbol('podium.terminal.message-write')
export type MessageWrite = typeof MESSAGE_WRITE

/**
 * How many typing marks one session keeps. A mark is read while its message is
 * still open (seconds to minutes), so only the newest few can matter; the
 * oldest is dropped first, and a dropped mark only means "no order credit".
 */
export const TYPING_MARKS_MAX = 64

/** Answers whether the attached surface is, right now, the only writer. */
export type ExclusiveWriterCheck = () => boolean

export class ForeignWriteCounter {
  private writes = 0
  private exclusive: ExclusiveWriterCheck | undefined = undefined
  private readonly typing = new Map<string, number>()

  /** Every foreign write and every exclusivity loss so far, this daemon life. */
  get count(): number {
    return this.writes
  }

  /**
   * Whether an unchanged count can be trusted to mean "nobody else wrote":
   * true only while a Terminal is attached over a backend whose writer lease
   * this daemon holds (podium-host). False on the abduco fallback, where any
   * `abduco -a` client writes unseen, while parked, and after a lease loss.
   */
  get orderTrustworthy(): boolean {
    return this.exclusive?.() === true
  }

  /** A write into the terminal that is not the typing message's own. */
  foreignWrite(): void {
    this.writes += 1
  }

  /** The writer lease was lost (stolen, or the connection holding it dropped). */
  leaseLost(): void {
    this.writes += 1
  }

  /**
   * A Terminal took the session's surface. Counted: while no Terminal was
   * attached anyone could have written, and nothing here saw it.
   */
  attached(exclusive: ExclusiveWriterCheck): void {
    this.writes += 1
    this.exclusive = exclusive
  }

  /**
   * A Terminal left the surface (parked, replaced, exited). Counted, for the
   * same gap. Only clears the exclusivity check it installed: a predecessor
   * parked after its successor attached must not blind the successor.
   */
  detached(exclusive: ExclusiveWriterCheck): void {
    this.writes += 1
    if (this.exclusive === exclusive) this.exclusive = undefined
  }

  /** Remember the count as `messageId`'s typing starts (spec §5.3, §9). */
  markTyping(messageId: string): void {
    this.typing.delete(messageId)
    this.typing.set(messageId, this.writes)
    if (this.typing.size > TYPING_MARKS_MAX) {
      const oldest = this.typing.keys().next().value
      if (oldest !== undefined) this.typing.delete(oldest)
    }
  }

  /** The count when `messageId`'s typing started, if it is still remembered. */
  typingMark(messageId: string): number | undefined {
    return this.typing.get(messageId)
  }
}
