import { createContext, useContext } from 'react'

/**
 * The element an expanded `OfferBar` paints its detail into (POD-1017).
 *
 * The fold used to be an in-flow `grid-template-rows` reveal, so opening it
 * took height from whatever sat above — in native mode that is the PTY, and a
 * re-grid mid-fold makes a TUI repaint its whole frame. The detail is portalled
 * into this layer instead: it slides up from the offer row and stops at the
 * panel header, and nothing above it ever changes size.
 *
 * A host that does not provide a layer (the issue dock, a bare test render)
 * gets the original in-flow fold, which is still the right shape there.
 */
export const OfferOverlayContext = createContext<HTMLElement | null>(null)

export const useOfferOverlayHost = (): HTMLElement | null => useContext(OfferOverlayContext)
