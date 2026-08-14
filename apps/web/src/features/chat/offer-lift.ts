import { createContext, type RefObject, useContext, useLayoutEffect, useMemo } from 'react'

/**
 * LIFTING HOST for the offer fold (POD-1068).
 *
 * The fold is an in-flow reveal: opening it grows the surface the offer sits on
 * (the native dock, the chat composer) upwards. In plain flex that height comes
 * out of whatever is above — the PTY in native mode — and re-gridding a live
 * terminal makes the TUI repaint its whole frame.
 *
 * So the height is not taken. It is PUSHED: the region above keeps the exact
 * box it had and translates up by the fold's height, running under the panel
 * header, while the seat's own negative top margin gives the flex solver back
 * the pixels the fold just added. Every frame of the animation leaves the
 * region's border box untouched, so no ResizeObserver fires and no PTY resizes.
 *
 * One number drives all of it: `--offer-lift` on the host root, from which the
 * seat's margin, the region's transform and clip, and the fold's own height are
 * each derived (see `.offer-lift-*` in styles.css). The pieces stay in lockstep
 * because they transition the same distance with the same curve.
 *
 * A host that provides no lift (the issue dock, a bare test render) gets the
 * original in-flow fold, which is the right shape where the offer is one card
 * in a scrolling list and there is nothing above it to disturb.
 */

/** The seat's own copy of the lift, set on the element the fold grows, so the
 *  OTHER seat in the same panel (chat mode keeps the native dock mounted at
 *  zero height) never pays a margin for a fold it is not showing. */
export const OFFER_SEAT_LIFT_VAR = '--offer-seat-lift'

/** Charge the fold's height to the seat it actually grew. */
export function chargeSeat(within: HTMLElement | null, px: number): void {
  const seat = within?.closest<HTMLElement>('.offer-lift-seat')
  if (!seat) return
  seat.style.setProperty(OFFER_SEAT_LIFT_VAR, `${Math.max(0, Math.round(px))}px`)
}
export type OfferLiftHost = {
  /** Publish the lift the open fold needs, in px. 0 closes it.
   *
   *  Keyed by caller: a panel can hold TWO offer bars for one offer — chat mode
   *  keeps the native dock mounted at zero height so it can animate away — and
   *  the closed one must not be able to overwrite the open one's number. */
  setLift: (caller: object, px: number) => void
  /** The largest lift this host will absorb; the fold scrolls past it. */
  room: () => number
  /** Call back when the room may have changed (the pane was resized). */
  watchRoom: (onChange: () => void) => () => void
}

/** Keep this much of the region above the offer on screen… */
const LIFT_FLOOR_PX = 96
/** …unless the pane is so short that 96px would be most of it. */
const LIFT_FLOOR_FRACTION = 0.25

export const OfferLiftContext = createContext<OfferLiftHost | null>(null)

export const useOfferLift = (): OfferLiftHost | null => useContext(OfferLiftContext)

/**
 * Wire a panel root as the lift host.
 *
 * `--offer-lift` is written straight onto the node rather than kept in state:
 * the whole point is that opening a fold costs the panel — and the terminal
 * inside it — nothing, and a re-render of this tree is exactly the cost we are
 * refusing to pay. It is primed at mount so the transitions have a value to
 * interpolate FROM on the very first open.
 *
 * The region being lifted is found by class: only one of a panel's two surfaces
 * (terminal, transcript) is ever on screen, and the hidden one measures zero.
 */
export function useOfferLiftHost(rootRef: RefObject<HTMLElement | null>): OfferLiftHost {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.style.setProperty('--offer-lift', '0px')
    root.dataset.offerLift = 'off'
  }, [rootRef])

  return useMemo<OfferLiftHost>(() => {
    const claims = new WeakMap<object, number>()
    const callers: object[] = []
    return {
      setLift: (caller, px) => {
        const root = rootRef.current
        if (!root) return
        if (!claims.has(caller)) callers.push(caller)
        claims.set(caller, Math.max(0, Math.round(px)))
        const lift = callers.reduce((most, c) => Math.max(most, claims.get(c) ?? 0), 0)
        root.style.setProperty('--offer-lift', `${lift}px`)
        root.dataset.offerLift = lift > 0 ? 'on' : 'off'
      },
      room: () => {
        const root = rootRef.current
        if (!root) return Number.POSITIVE_INFINITY
        for (const region of root.querySelectorAll<HTMLElement>('.offer-lift-region')) {
          const height = region.clientHeight
          if (height <= 0) continue
          return Math.max(0, height - Math.min(LIFT_FLOOR_PX, height * LIFT_FLOOR_FRACTION))
        }
        // Nothing on screen to lift (a parked pane measures zero). Whatever the
        // fold asks for is free; the pane re-measures when it comes back.
        return Number.POSITIVE_INFINITY
      },
      watchRoom: (onChange) => {
        const root = rootRef.current
        if (!root || typeof ResizeObserver === 'undefined') return () => {}
        const observer = new ResizeObserver(onChange)
        observer.observe(root)
        return () => observer.disconnect()
      },
    }
  }, [rootRef])
}
