import {
  type IssueReferenceModel,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/viewmodels'

export type IssueReferenceLookup = ReadonlyMap<string, IssueReferenceModel>

/** Build the live presentation index without making rendered Markdown depend on it. */
export function issueReferenceLookup(
  issues: readonly IssueReferenceSource[],
): IssueReferenceLookup {
  return new Map(
    issues.map((issue) => {
      const model = issueReferenceModel(issue)
      return [model.ref, model] as const
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
    const model = refs.get(ref)
    setOrRemove(anchor, 'data-issue-stage', model?.stage ?? null)
    setOrRemove(anchor, 'data-issue-availability', model?.availability ?? 'unavailable')
    setOrRemove(anchor, 'aria-label', model?.accessibleLabel ?? `Task ${ref} is unavailable`)
  }
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
