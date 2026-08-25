import { segmentOfferText } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'

/**
 * An offer's detail prose, with the URLs an agent wrote rendered as links.
 *
 * NEW WINDOW, ALWAYS. An offer sits under a live session; navigating the tab
 * away from it would drop the transcript the operator is reading, so every link
 * carries `target="_blank"`. In the desktop shell the injected opener shim
 * (apps/desktop/src-tauri/src/bootstrap.rs) catches the click first and hands
 * the URL to the OS browser — WKWebView otherwise swallows `_blank` silently —
 * so the same anchor is what makes this work in the macOS app.
 *
 * The click is stopped from bubbling: the fold's own controls sit around this
 * prose, and following a link is not also a request to collapse the offer.
 */
export function OfferText({ text, className }: { text: string; className?: string }): JSX.Element {
  return (
    <p className={className}>
      {segmentOfferText(text).map((segment, index) =>
        segment.kind === 'link' ? (
          <a
            // Segments are positional; a URL repeated in one message is the
            // same href twice and has no better key than where it sits.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="offer-fold-link"
          >
            {segment.text}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  )
}
