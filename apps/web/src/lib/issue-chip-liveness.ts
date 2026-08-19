import type { IssueReferenceLookup } from './markdown'

/**
 * LIVENESS IS AN ATTRIBUTE PASS, NOT A REWRITE (POD-1290 follow-up, the
 * selection-death clock of 2026-08-19).
 *
 * Ref chips used to bake live issue state — stage, availability, the
 * accessible label — into their HTML string. Agent transcripts are littered
 * with refs, and a fleet of agents updates issues every few seconds; each
 * delta that touched a referenced issue changed some row's html, React
 * rewrote that row's innerHTML, and the row's whole subtree was destroyed
 * and recreated. The reader saw it as text selection dying on a 2–5 second
 * clock, and as the transcript shifting under the scroller — the residual
 * "jump" that survived every scroll-side repair, because it was never a
 * scroll bug.
 *
 * The chip string is stable now (see `refAnchor` in markdown.ts); THIS is
 * where a chip becomes live. Attribute writes destroy no nodes: selection
 * survives, rows never rebuild, and a delta costs one sweep of cheap
 * compare-and-set attribute writes instead of a feed-wide sanitize+rewrite.
 */
export function decorateRefAnchors(root: ParentNode, refs: IssueReferenceLookup): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a.ref-link--issue[data-ref]')) {
    const model = refs.get(anchor.dataset.ref ?? '')
    setOrRemove(anchor, 'data-issue-stage', model?.stage ?? null)
    setOrRemove(anchor, 'data-issue-availability', model?.availability ?? null)
    setOrRemove(anchor, 'aria-label', model?.accessibleLabel ?? null)
  }
}

/** Compare-before-write, so an unchanged delta does not even dirty the DOM. */
function setOrRemove(el: HTMLElement, name: string, value: string | null): void {
  if (value === null || value === '') {
    if (el.hasAttribute(name)) el.removeAttribute(name)
    return
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}
