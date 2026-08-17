import type { JSX } from 'react'
import { AsciiLoader } from './AsciiLoader'

/**
 * The cold-start splash: the ASCII wordmark over the themed background.
 *
 * Rendered by every boot gate that used to render NOTHING — LoginGate and
 * SetupGate's network round-trips, AppShell's replica open, and AppBody's
 * enrichment wait (POD-1249). One shared component so the phases hand off
 * visually even though the tree position changes between them; AsciiLoader's
 * reveal animation plays once per session, so the hand-offs don't re-sparkle.
 */
export function LoadingScreen(): JSX.Element {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <AsciiLoader />
    </div>
  )
}
