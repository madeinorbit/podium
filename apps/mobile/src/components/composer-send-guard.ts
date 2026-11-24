/**
 * THE DOUBLE-TAP GUARD ON SEND (POD-2423).
 *
 * The composer empties on the same press that sends, so an ordinary second tap
 * finds nothing to send. What still gets through is the press that lands in the
 * same frame as the first one, or right after something refills the field with
 * the words that just left. That is how one prompt reached the agent twice,
 * 0.4 s apart. Inside a short window, the same words with the same files are
 * taken as the same press. After the window, a resend is a choice the operator
 * made, and it goes through.
 */

/** Long enough to cover a double tap and a re-render; short enough that a
 *  deliberate resend never waits for it. */
export const DUPLICATE_SEND_WINDOW_MS = 1500

export interface SendGuard {
  /** True when this send should go out; records it as the last one. */
  admit(text: string, fileKeys?: readonly string[]): boolean
}

export function createSendGuard(now: () => number = Date.now): SendGuard {
  let last: { key: string; at: number } | null = null
  return {
    admit(text, fileKeys = []) {
      const key = `${text.trim()}\u0000${fileKeys.join('\u0000')}`
      const at = now()
      if (last && last.key === key && at - last.at < DUPLICATE_SEND_WINDOW_MS) return false
      last = { key, at }
      return true
    },
  }
}
