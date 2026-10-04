import type { IssueReferenceModel } from '@podium/client-core/values'

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
  changed =
    setOrRemove(
      anchor,
      'data-issue-availability',
      loading ? 'loading' : (ready?.availability ?? 'unavailable'),
    ) || changed
  changed =
    setOrRemove(
      anchor,
      'aria-label',
      ready?.accessibleLabel ?? `Task ${ref} is ${loading ? 'loading' : 'unavailable'}`,
    ) || changed
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
    bindings.set(anchor, {
      ref,
      stop: reader.watch(ref, (model) => paintIssueRefAnchor(anchor, model)),
    })
  }
  const add = (node: ParentNode): void => {
    for (const anchor of issueAnchorsWithin(node)) bind(anchor)
  }
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
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ref'],
  })
  return () => {
    observer.disconnect()
    for (const binding of bindings.values()) binding.stop()
    bindings.clear()
  }
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
