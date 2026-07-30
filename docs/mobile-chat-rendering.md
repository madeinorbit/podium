# Expo chat rendering architecture

Status: Accepted for POD-1197 · 2026-07-30

## Decision

Keep the Expo chat shell native. Parse message Markdown with the same marked GFM parser used by desktop, then render the resulting token tree as React Native views and text.

The parity boundary is semantic rather than DOM-level: headings, paragraphs, emphasis, strike-through, lists and tasks, blockquotes, code and diffs, tables, links, and issue references use the same Markdown grammar while adopting native scrolling, selection, accessibility, and navigation. Wide tables and code blocks scroll horizontally inside the transcript.

## Why the whole chat should not be a WebView

The native screen already owns transcript paging and bottom pinning, optimistic sends and retries, question cards, tool batches, task peeks, the composer and keyboard, offline state, and native navigation. Moving the whole view into a WebView would require a bridge for all of those behaviors and introduce a second scrolling, focus, accessibility, theming, and lifecycle boundary.

A WebView per message is worse: virtualized rows would each need dynamic height synchronization and an embedded browser context. That is expensive and tends to produce scroll jumps as content settles.

## Security and interaction boundary

The renderer consumes parser tokens, not generated HTML, so it does not need a DOM sanitizer. Raw HTML is deliberately ignored. Only HTTP, HTTPS, mail, and telephone URLs become tappable; issue references stay in-app and open the native task peek.

## Reconsideration threshold

Reconsider a single Markdown-only WebView, not a WebView for the entire chat, if transcript requirements expand to arbitrary sanitized HTML, math, or a plugin ecosystem that cannot be represented faithfully and performantly with native components. Any such change must retain native ownership of transcript data, composer state, questions, tools, and navigation.

## Verification

The Expo web runtime was driven at 390 × 844. A three-column GFM table measured 397 px inside a 358 px viewport and scrolled its full 39 px overflow; the POD-87 reference opened the native task peek; an HTTPS link opened externally; and no page errors were emitted.

Desktop transcript-only content branches were exercised in the same runtime: Podium message envelopes, reply-request metadata, transferred-file chips and session URLs, Markdown-formatted recaps, and the collapsed headless-context disclosure. The disclosure was opened with a real click and its expanded text was observed.

The native bundle boundary was checked with an Android production export. Focused parser and asset-route tests, mobile/web/client-core type checks, and the repository suite cover the non-visual paths.
