import type { JSX } from 'react'
import { useEffect } from 'react'

/**
 * THIS PAGE IS NOT THE INSTALLED APP.
 *
 * Iteration mode (`bun run iterate`, updater-convergence spec §7) serves the web
 * UI from source against the LIVE installed server. Everything else about the
 * tab looks identical to the installed UI — same origin family, same data, same
 * sessions — so without a mark, "why didn't my fix show up" and "why is the live
 * app broken" become the same afternoon. The desktop shell has the equivalent
 * signal already: a debug build refuses to update at all (`DebugBuild`).
 *
 * A FRAME, NOT A BANNER, and that is the considered part. The wire-skew banner
 * above it is a full-width strip that reserves height, which is right for a
 * condition you must act on and wrong for a mode you work inside all day: it
 * would move every element down, so the layout being iterated on would not be
 * the layout that ships. The frame draws on top of nothing, reserves no space,
 * and `pointer-events: none` throughout means it can never swallow a click —
 * the app underneath behaves exactly as the installed one does.
 *
 * The label sits under the skew banner's published height, so when both are up
 * they stack instead of overlapping.
 */

/** Prefix on `document.title`, so a background tab is identifiable too. */
export const ITERATION_TITLE_PREFIX = '◆ '

/** Idempotent — React re-renders, and the title must not grow a prefix each time. */
export function iterationTitle(title: string, active: boolean): string {
  const bare = title.startsWith(ITERATION_TITLE_PREFIX)
    ? title.slice(ITERATION_TITLE_PREFIX.length)
    : title
  return active ? `${ITERATION_TITLE_PREFIX}${bare}` : bare
}

const EDGE = '#f5a524'

export function IterationModeFrame({
  active = import.meta.env.PODIUM_ITERATION_MODE,
}: {
  /** Injected for the test; production reads the build-time define. */
  active?: boolean
} = {}): JSX.Element | null {
  useEffect(() => {
    if (!active) return
    document.title = iterationTitle(document.title, true)
  }, [active])

  if (!active) return null

  return (
    <div
      data-testid="iteration-mode-frame"
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        // Under the skew banner (2147483647): that one is a condition to act on.
        zIndex: 2147483646,
        pointerEvents: 'none',
        border: `2px solid ${EDGE}`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 'var(--wire-skew-banner-h, 0px)',
          left: 0,
          pointerEvents: 'none',
          background: EDGE,
          color: '#1a1a1a',
          padding: '1px 8px 2px',
          borderBottomRightRadius: '6px',
          font: '700 10px/1.4 ui-sans-serif, system-ui, sans-serif',
          letterSpacing: '0.08em',
        }}
      >
        ITERATION MODE
      </div>
    </div>
  )
}
