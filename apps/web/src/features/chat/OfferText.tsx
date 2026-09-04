import { segmentOfferText } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import {
  classifyPodiumLink,
  internalPodiumTarget,
  systemBrowserPodiumHref,
} from '@/lib/podium-link'
import { handlePodiumLinkClick } from '@/lib/podium-link-click'

/**
 * An offer's detail prose, with the URLs an agent wrote rendered as links.
 *
 * A NEW WINDOW FOR SOMEONE ELSE'S URL. An offer sits under a live session;
 * navigating the tab away from it would drop the transcript the operator is
 * reading, so an external link carries `target="_blank"`. In the desktop shell
 * the injected opener shim (apps/desktop/src-tauri/src/bootstrap.rs) catches the
 * click first and hands the URL to the OS browser — WKWebView otherwise swallows
 * `_blank` silently — so the same anchor is what makes this work in the macOS
 * app.
 *
 * IN-APP FOR OURS (POD-1606). When the URL names something on a Podium this
 * client knows — an issue, a session, an artifact, a file — a new browser tab is
 * the wrong answer twice over: it leaves the app for a page the app already is,
 * and in the packaged macOS app it used to leave for Safari entirely. Those
 * navigate in place, through the same handler the transcript uses, which also
 * owns what a held modifier means. The href stays real so browser new-tab and
 * copy actions use the active server; the desktop host explicitly handles
 * modifier and middle clicks. An address this client cannot resolve falls back
 * to plain navigation rather than becoming a dead click.
 *
 * The click is stopped from bubbling: the fold's own controls sit around this
 * prose, and following a link is not also a request to collapse the offer.
 */
export function OfferText({ text, className }: { text: string; className?: string }): JSX.Element {
  return (
    <p className={className}>
      {segmentOfferText(text).map((segment, index) => {
        if (segment.kind !== 'link') {
          // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
          return <span key={index}>{segment.text}</span>
        }
        const target = internalPodiumTarget(segment.href)
        const link = classifyPodiumLink(segment.href)
        const href = link?.kind === 'internal' ? systemBrowserPodiumHref(segment.href) : null
        return (
          <a
            // Segments are positional; a URL repeated in one message is the
            // same href twice and has no better key than where it sits.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
            key={index}
            href={href ?? segment.href}
            data-podium-link-candidate=""
            data-podium-link-source={segment.href}
            data-podium-link={link?.kind === 'internal' ? '' : undefined}
            {...(target ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
            onClick={(event) => {
              event.stopPropagation()
              handlePodiumLinkClick(event)
            }}
            className="offer-fold-link"
          >
            {segment.text}
          </a>
        )
      })}
    </p>
  )
}
