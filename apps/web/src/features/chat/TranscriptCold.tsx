import type { JSX } from 'react'

/**
 * THE COLD TRANSCRIPT (POD-700) — the feed while its first read is in flight and
 * the replica has no cached window to paint instead.
 *
 * It replaces a 420px chip that sat dead-centre in a ~900px scrollport, shaped
 * identically to "No transcript yet", so a state that resolves and one that never
 * will were the same object with different words. Measured on the live instance,
 * that chip is not a flash: a cold panel open holds it 545ms at p50 and up to
 * 8.7s at the tail.
 *
 * Three rules, taken from the usage sheet's cold pass (POD-394):
 *
 * IT IS THE TRANSCRIPT, NOT A SKELETON OF ONE. The slots are the feed's own
 * geometry at its own metrics — the carved prompt box, the mono labels, prose at
 * the reading leading, the 22px seam between exchanges — so whatever lands, lands
 * into the layout already on screen. And, as on the usage sheet, each run is
 * mixed from the ink of the thing it stands in for rather than from one flat
 * grey: the answer's prose slots are Foreground, its label is Muted. A single
 * value for every slot reads as one texture and inverts the hierarchy.
 *
 * IT FILLS THE PANE, BOTTOM UP. A loaded transcript is scrolled to its end with
 * text through the whole viewport, so a cold pass that occupies only a strip
 * above the composer predicts the wrong thing and leaves the void this issue is
 * about. Four exchanges reach the top of a tall pane and are clipped, not
 * scrolled, by the block's own max-height; the top edge fades because the one
 * thing genuinely unknown before the read is how much sits above.
 *
 * IT IS STILL. DESIGN.md spends perpetual motion only on "an agent is computing
 * right now", and a shimmer here would be a second signal competing with the
 * working grammar for the same eye. Timing carries the state instead, in two
 * CSS-delayed one-shots, so no JS timer and no extra state exist to drift out of
 * step with the read: the slots resolve in at 180ms, so a read that beats them
 * never blinks anything on screen, and the mono admission joins only past 1.2s,
 * when the read has become slow enough to be worth saying. Screen readers are
 * told immediately and wait for neither.
 */

/** One exchange. `lines` is the answer's prose run — the shape varies down the
 *  stack because a conversation does not wrap at one measure. */
function ColdTurn({ prompt, lines }: { prompt: number; lines: number }): JSX.Element {
  return (
    <div className="transcript-cold-turn" aria-hidden="true">
      <span className="transcript-cold-label" />
      <div className="transcript-cold-prompt">
        {Array.from({ length: prompt }, (_, i) => (
          <span className="transcript-cold-line" key={i} />
        ))}
      </div>
      <span className="transcript-cold-label transcript-cold-label--answer" />
      <div className="transcript-cold-answer">
        {Array.from({ length: lines }, (_, i) => (
          <span className="transcript-cold-line" key={i} />
        ))}
      </div>
    </div>
  )
}

export function TranscriptCold({ compact }: { compact: boolean }): JSX.Element {
  return (
    <div
      className="transcript-cold"
      data-testid="transcript-cold"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading transcript</span>
      <div className="transcript-cold-stack">
        <ColdTurn prompt={1} lines={4} />
        <ColdTurn prompt={2} lines={3} />
        <ColdTurn prompt={1} lines={5} />
        <ColdTurn prompt={2} lines={3} />
      </div>
      {/* Machine voice, and only once the read has earned it. */}
      <p className={compact ? 'transcript-cold-note is-compact' : 'transcript-cold-note'}>
        reading transcript
      </p>
    </div>
  )
}
