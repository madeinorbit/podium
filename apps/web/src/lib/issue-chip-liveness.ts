import {
  type IssueReferenceModel,
  type IssueReferenceSource,
  canonicalIssueRef,
  issueReferenceModel,
} from '@podium/client-core/values'
import { parseAnyRef } from '@podium/protocol'

export type IssueReferenceLookup = ReadonlyMap<string, IssueReferenceModel>

/** The pool supplies one tracked value per token. Its subscription compares
 * displayed fields and never publishes a list of issues to the decorator. */
export interface IssueChipReader {
  watch(ref: string, paint: (model: IssueReferenceModel | 'loading' | null) => boolean): () => void
}

export function paintIssueRefAnchor(
  anchor: HTMLAnchorElement,
  model: IssueReferenceModel | 'loading' | null,
): boolean {
  const ref = anchor.dataset.ref ?? ''
  const loading = model === 'loading'
  const ready = loading ? null : model
  let changed = setOrRemove(anchor, 'data-issue-stage', ready?.stage ?? null)
  changed = setOrRemove(anchor, 'data-issue-availability', loading ? 'loading' : ready?.availability ?? 'unavailable') || changed
  changed = setOrRemove(anchor, 'aria-label', ready?.accessibleLabel ?? `Task ${ref} is ${loading ? 'loading' : 'unavailable'}`) || changed
  return changed
}

/** Subscribe once per anchor, then visit only anchors added/retargeted by DOM
 * changes. An issue publication does not query or sweep the transcript. */
export function bindIssueRefAnchors(root: HTMLElement, reader: IssueChipReader): () => void {
  const bindings = new Map<HTMLAnchorElement, { ref: string; stop: () => void }>()
  const bind = (anchor: HTMLAnchorElement): void => {
    const ref = anchor.dataset.ref ?? ''
    const previous = bindings.get(anchor)
    if (previous?.ref === ref) return
    previous?.stop()
    bindings.set(anchor, { ref, stop: reader.watch(ref, (model) => paintIssueRefAnchor(anchor, model)) })
  }
  const add = (node: ParentNode): void => { for (const anchor of issueAnchorsWithin(node)) bind(anchor) }
  add(root)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLAnchorElement) bind(record.target)
      } else {
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement)) continue
          for (const anchor of issueAnchorsWithin(node)) {
            if (root.contains(anchor)) continue
            bindings.get(anchor)?.stop()
            bindings.delete(anchor)
          }
        }
        for (const node of record.addedNodes) if (node instanceof HTMLElement) add(node)
      }
    }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ref'] })
  return () => {
    observer.disconnect()
    for (const binding of bindings.values()) binding.stop()
    bindings.clear()
  }
}

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

/**
 * The same key, derived from the issue side.
 *
 * Keyed on the same canonical ref the model announces (`canonicalIssueRef`),
 * normalised through `refKey` so a zero-padded anchor (`POD-013`) still meets
 * its row (`POD-13`). A real `displayRef` wins over a stale legacy prefix
 * (prefix-change case); a `#seq` fallback defers to `prefix` (POD-4731: merged
 * replica row with legacy `POD` beside view-derived `#17`); truly prefix-less
 * rows key `#seq` and only meet `#seq` anchors.
 *
 * The signature below reads through here too. Two fallbacks for one key is how
 * they drift apart, and a drift means a cached map surviving a change it should
 * have been rebuilt for.
 */
function issueKey(issue: IssueReferenceSource): string {
  return refKey(canonicalIssueRef(issue))
}

/** Build the live presentation index without making rendered Markdown depend on it. */
export function issueReferenceLookup(
  issues: readonly IssueReferenceSource[],
): IssueReferenceLookup {
  return new Map(issues.map((issue) => [issueKey(issue), issueReferenceModel(issue)] as const))
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
 * These fields are the complete input to {@link issueReferenceModel}, read raw
 * rather than through it: the model allocates an object and builds a label
 * string per issue, and this runs over every issue in the repo on every render
 * of the subscriber.
 */
export function issueReferenceSignature(issues: readonly IssueReferenceSource[]): string {
  const parts: string[] = []
  for (const issue of issues) {
    parts.push(
      // Both: the KEY decides which anchor a model answers for, and
      // `displayRef` is what the accessible label reads back. A row that gains
      // a displayRef keeps its prefix+seq key, so the key alone would not
      // rotate and the label would stay stale in a cached map.
      issueKey(issue),
      issue.displayRef ?? '',
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

function setOrRemove(element: HTMLElement, name: string, value: string | null): boolean {
  if (value === null || value === '') {
    if (!element.hasAttribute(name)) return false
    element.removeAttribute(name)
    return true
  }
  if (element.getAttribute(name) === value) return false
  element.setAttribute(name, value)
  return true
}
