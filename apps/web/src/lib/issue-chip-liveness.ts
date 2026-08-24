import {
  type IssueReferenceModel,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/viewmodels'
import { parseAnyRef } from '@podium/protocol'

export type IssueReferenceLookup = ReadonlyMap<string, IssueReferenceModel>

/**
 * The lookup key for one ref token.
 *
 * NOT the token as written. `resolveIssueReference` and the miniview both match
 * an issue by parsed prefix + seq, so `POD-013` opens POD-13's popup — and a
 * lookup keyed on the raw string would leave that same chip painted unavailable.
 * The chip and the click have to agree about which issue a token names, so both
 * sides normalise. A token that is not an issue ref keys on itself and never
 * matches, which is what a session ref or a stray string should do.
 */
function refKey(token: string): string {
  const parsed = parseAnyRef(token)
  return parsed?.kind === 'issue' ? `${parsed.prefix}-${parsed.seq}` : token
}

/** Build the live presentation index without making rendered Markdown depend on it. */
export function issueReferenceLookup(
  issues: readonly IssueReferenceSource[],
): IssueReferenceLookup {
  return new Map(
    issues.map((issue) => {
      const model = issueReferenceModel(issue)
      return [refKey(model.ref), model] as const
    }),
  )
}

/**
 * Apply live issue state to the anchors that already exist in a transcript.
 *
 * Markdown owns the anchor and text nodes. This pass owns only semantic
 * attributes, using compare-before-write so an unchanged issue notification
 * does not dirty the DOM. Unknown or newly invisible refs remain explicitly
 * unavailable instead of inheriting stale state from their last visible row.
 */
export function decorateIssueRefAnchors(root: ParentNode, refs: IssueReferenceLookup): void {
  for (const anchor of issueAnchorsWithin(root)) {
    const ref = anchor.dataset.ref ?? ''
    const model = refs.get(refKey(ref))
    setOrRemove(anchor, 'data-issue-stage', model?.stage ?? null)
    setOrRemove(anchor, 'data-issue-availability', model?.availability ?? 'unavailable')
    setOrRemove(anchor, 'aria-label', model?.accessibleLabel ?? `Task ${ref} is unavailable`)
  }
}

/** The separator inside a signature: a character no title, ref or stage can
 *  contain, so no field's content can forge a boundary and hide a change. */
const FIELD_SEPARATOR = '\u0000'

/**
 * What the chips actually read off the issue list, as one comparable string.
 *
 * The issue view models are rebuilt whenever the replica snapshot rotates, and
 * that snapshot derives from SESSIONS as well as issues — so in a live fleet the
 * array identity changes every few seconds for reasons no chip can see. Keyed on
 * that identity, the decoration pass re-arms its observer and sweeps the whole
 * transcript, before paint, on every agent's every phase flip.
 *
 * These five fields are the complete input to {@link issueReferenceModel}, read
 * raw rather than through it: the model allocates an object and builds a label
 * string per issue, and this runs over every issue in the repo on every render
 * of the subscriber.
 */
export function issueReferenceSignature(issues: readonly IssueReferenceSource[]): string {
  const parts: string[] = []
  for (const issue of issues) {
    parts.push(
      issue.displayRef ?? `${issue.prefix ?? ''}-${issue.seq}`,
      issue.stage,
      issue.archived ? '1' : '',
      issue.deletedAt ?? '',
      issue.title,
    )
  }
  return parts.join(FIELD_SEPARATOR)
}

function issueAnchorsWithin(root: ParentNode): HTMLAnchorElement[] {
  const selector = 'a.ref-link--issue[data-ref]'
  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>(selector))
  if (root instanceof HTMLAnchorElement && root.matches(selector)) anchors.unshift(root)
  return anchors
}

function setOrRemove(element: HTMLElement, name: string, value: string | null): void {
  if (value === null || value === '') {
    if (element.hasAttribute(name)) element.removeAttribute(name)
    return
  }
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}
