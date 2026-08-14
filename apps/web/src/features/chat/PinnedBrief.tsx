/**
 * THE PINNED BRIEF (POD-993 round 2) — the shelf drawn OVER the feed.
 *
 * A long answer pushes the question that caused it off the top of the screen,
 * and the reader loses the one piece of context every line below depends on. The
 * shelf is the answer to that, and the whole design of it follows from one
 * constraint: it must be able to appear and leave WITHOUT MOVING A ROW.
 *
 * That is why it is absolutely positioned over the column rather than sticky
 * inside it. A sticky row is still in the flow — it changes the height of the
 * document as it pins and unpins, so the words the reader is mid-sentence on
 * shift under them, and two consecutive briefs have to be hand-translated past
 * one another on every scroll frame. Overlaying costs one thing, occlusion, and
 * pays for it with a blur and a rim so what is underneath reads as underneath.
 *
 * It keeps the brief's own geometry — same radius, same measure, same ink — so
 * the reader recognises it as the message they wrote and not as a new kind of
 * chrome. What it adds is what a shelf needs and a message does not: a height.
 * Clamped to two lines behind a mask that fades the third, with one control on
 * the right to open it in place. Expanded, it scrolls inside itself and keeps
 * that control in reach.
 */
import type { JSX } from 'react'
import { useState } from 'react'
import type { PinnedBrief as PinnedBriefState } from './use-transcript-scroll'

export function PinnedBrief({ brief }: { brief: PinnedBriefState | null }): JSX.Element | null {
  // Opening is a gesture that belongs to the MOMENT, not to the message: any
  // change of which brief the shelf is carrying closes it again, including
  // scrolling back to one that was open earlier. Adjusting during render rather
  // than in an effect, which is React's own answer to derived state — there is
  // never a frame in which the new brief is drawn at the old brief's height.
  const [pin, setPin] = useState<{ key: string | null; open: boolean }>({ key: null, open: false })
  const key = brief?.key ?? null
  if (pin.key !== key) setPin({ key, open: false })
  const open = pin.key === key && pin.open
  if (!brief) return null
  return (
    <div className="brief-shelf-layer" data-testid="pinned-brief">
      <div className="brief-shelf" data-open={open ? 'true' : undefined}>
        <div
          className="brief-shelf-text"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: lifted verbatim from the row's own body, which renderMarkdown already sanitized
          dangerouslySetInnerHTML={{ __html: brief.html }}
        />
        <div className="brief-shelf-side">
          {brief.time !== '' && <span className="brief-shelf-time">{brief.time}</span>}
          <button
            data-pressable
            type="button"
            className="brief-shelf-toggle"
            data-testid="prompt-expand-toggle"
            aria-expanded={open}
            onClick={() => {
              setPin({ key: brief.key, open: !open })
            }}
          >
            {open ? 'Show less' : 'Show full'}
          </button>
        </div>
      </div>
    </div>
  )
}
