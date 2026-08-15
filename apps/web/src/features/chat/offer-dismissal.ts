import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

/** The bar's own exit animation, before the undo row takes its place. */
export const OFFER_EXIT_MS = 180
/** How long the offer stays recoverable before the server write goes out. */
export const OFFER_UNDO_MS = 10_000
/** The undo row's fade, run inside the tail of the undo window. */
export const OFFER_UNDO_FADE_MS = 500

export type OfferDismissalPhase = 'visible' | 'leaving' | 'undo' | 'undo-leaving'

export type OfferDismissalHost = {
  /** The offer stamp under dismissal — null when nothing is being dismissed. */
  readonly at: string | null
  readonly phase: OfferDismissalPhase
  /** Open the undo window for `offerCreatedAt`. `commit` runs when it closes;
   *  if it rejects, the offer comes back on every bar. */
  begin: (offerCreatedAt: string, commit: () => Promise<void> | void) => void
  /** Put the offer back. */
  undo: () => void
}

/**
 * Dismissal is a fact about the OFFER, not about the bar you clicked.
 *
 * A panel holds TWO bars for one offer — chat mode keeps the native dock
 * mounted at zero height so it can animate away — and the server write that
 * takes the offer off every surface is deliberately deferred by the ten-second
 * undo window. Left per-bar, that window is ten seconds in which the other view
 * still shows a decision the operator has already made, so switching views
 * reads as "I have to dismiss it twice" (POD-1103).
 *
 * So the phase lives here, above both bars, and the undo window is shared: the
 * offer leaves both views on the click, and Undo from either brings it back to
 * both. The deferred server write is unchanged — this only stops the two bars
 * from disagreeing while it waits.
 */
export const OfferDismissalContext = createContext<OfferDismissalHost | null>(null)

export function useOfferDismissalHost(): OfferDismissalHost {
  const [state, setState] = useState<{ at: string | null; phase: OfferDismissalPhase }>({
    at: null,
    phase: 'visible',
  })
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Mirrors `state.at` for the timers: they must test the dismissal they were
  // scheduled for against the CURRENT one, and a state read in their closure
  // would be the value at schedule time.
  const pending = useRef<string | null>(null)

  const clearTimers = useCallback((): void => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
  }, [])

  const undo = useCallback((): void => {
    clearTimers()
    pending.current = null
    setState({ at: null, phase: 'visible' })
  }, [clearTimers])

  const begin = useCallback(
    (offerCreatedAt: string, commit: () => Promise<void> | void): void => {
      clearTimers()
      pending.current = offerCreatedAt
      setState({ at: offerCreatedAt, phase: 'leaving' })
      const current = (): boolean => pending.current === offerCreatedAt
      timers.current = [
        setTimeout(() => {
          if (current()) setState({ at: offerCreatedAt, phase: 'undo' })
        }, OFFER_EXIT_MS),
        setTimeout(
          () => {
            if (current()) setState({ at: offerCreatedAt, phase: 'undo-leaving' })
          },
          OFFER_EXIT_MS + OFFER_UNDO_MS - OFFER_UNDO_FADE_MS,
        ),
        // Not cancelled on unmount, and that is the contract: a dismissal the
        // operator has made is a promise to write it, and the panel can be
        // unmounted (view switch, pane close) while the window runs.
        setTimeout(() => {
          if (!current()) return
          void (async () => {
            try {
              await commit()
              // On success the phase is left where it is — the host that owns
              // the offer removes the bar (optimistic hide, then the server's
              // cleared session meta), exactly as it did before.
            } catch {
              if (!current()) return
              pending.current = null
              setState({ at: null, phase: 'visible' })
            }
          })()
        }, OFFER_EXIT_MS + OFFER_UNDO_MS),
      ]
    },
    [clearTimers],
  )

  return useMemo(
    () => ({ at: state.at, phase: state.phase, begin, undo }),
    [state.at, state.phase, begin, undo],
  )
}

/**
 * One bar's view of the shared dismissal. Falls back to a private host when
 * there is no provider above it, so a bar mounted outside a panel keeps the
 * behaviour it had.
 */
export function useOfferDismissal(offerCreatedAt: string): {
  phase: OfferDismissalPhase
  begin: (commit: () => Promise<void> | void) => void
  undo: () => void
} {
  const shared = useContext(OfferDismissalContext)
  const fallback = useOfferDismissalHost()
  const host = shared ?? fallback
  return useMemo(
    () => ({
      // Keyed by stamp, so a NEW offer arriving during another's undo window is
      // visible immediately and never inherits its predecessor's phase.
      phase: host.at === offerCreatedAt ? host.phase : 'visible',
      begin: (commit: () => Promise<void> | void) => host.begin(offerCreatedAt, commit),
      undo: host.undo,
    }),
    [host, offerCreatedAt],
  )
}
