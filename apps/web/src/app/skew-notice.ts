/**
 * "THIS BUILD AND THIS SERVER DISAGREE" — one place, two reporters (POD-1610).
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE-LEVEL STORE AND NOT STATE IN THE PROVIDER
 * ---------------------------------------------------------------------------
 *
 * The banner has to render in the state where everything else has failed. The
 * outage this exists for left the app on an empty board with the replica never
 * bootstrapped; a notice living inside the store's subtree would have been
 * mounted by the same machinery that was broken. This is a plain module
 * subscription: no context, no store, no replica, readable from the shell's
 * outermost component.
 *
 * TWO REPORTERS, ONE STATEMENT. The boot check (`version-guard`, comparing the
 * server's advertised schema digest with this bundle's) fires BEFORE anything
 * breaks; the transport (`hub.onWireSkew`) fires when something actually has.
 * They are evidence of the same fact at different times, so they share a surface
 * and the more severe wins — otherwise a user gets two banners for one problem,
 * and learns to dismiss both.
 */

export type SkewSource = 'boot-digest' | 'dropped-frames'

export interface SkewNotice {
  source: SkewSource
  /** One sentence, in a person's terms. Never a ZodError. */
  message: string
  /** Whether the app is likely showing NOTHING rather than merely something
   *  incomplete — a refused frame on the bootstrap path. Decides the wording. */
  severe: boolean
}

/**
 * The transport's tally, as a sentence.
 *
 * The severity split is the useful part: a QUARANTINED row means the view in
 * front of the user is missing an item, and a REFUSED frame means the view may
 * be missing everything — which is the difference between "something looks odd"
 * and the empty board of POD-1610. Both say the same remedy, because there is
 * only one: get a build that matches the server.
 */
export function describeWireSkew(skew: { quarantined: number; refusedFrames: number }): SkewNotice {
  const severe = skew.refusedFrames > 0
  return {
    source: 'dropped-frames',
    severe,
    message: severe
      ? 'This app build cannot read what the server is sending, so parts of it may be ' +
        'empty or stuck. It is older than the server. Reload to pick up a newer build — ' +
        'if that does not help, the build being served needs rebuilding.'
      : `${skew.quarantined} item${skew.quarantined === 1 ? '' : 's'} from the server could ` +
        'not be read by this app build and are missing from these views. Reload to pick up ' +
        'a newer build.',
  }
}

let current: SkewNotice | null = null
const listeners = new Set<(notice: SkewNotice | null) => void>()

/** Ranked so a later, milder report cannot replace a live severe one. */
const rank = (notice: SkewNotice): number => (notice.severe ? 2 : 1)

export function reportSkew(notice: SkewNotice): void {
  if (current && rank(current) > rank(notice)) return
  // Same content, same severity: don't churn subscribers on every dropped frame.
  if (current && current.message === notice.message && current.severe === notice.severe) return
  current = notice
  for (const listener of listeners) listener(current)
}

export function currentSkew(): SkewNotice | null {
  return current
}

export function subscribeSkew(listener: (notice: SkewNotice | null) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only reset. Module state outlives a test file's cases; without this the
 *  first case's notice would decide the rest. */
export function resetSkewNotice(): void {
  current = null
  listeners.clear()
}
