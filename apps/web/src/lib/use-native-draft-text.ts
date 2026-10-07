import type { RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'

/** Keep native edits in the field while its authoritative draft publishes.
 * A controlled field restores stale props at input-end when a pool preference
 * publishes in a later microtask. Even synchronous drafts can mirror changed
 * textarea default text. Seed that default once; adopt only different text.
 * The draft action remains the state owner, including reset and external edits.
 */
export function useNativeDraftText(
  fieldRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  value: string,
  owner?: string,
): string {
  const initialValue = useRef(value)
  const previousOwner = useRef(owner)
  useLayoutEffect(() => {
    const ownerChanged = previousOwner.current !== owner
    previousOwner.current = owner
    const field = fieldRef.current
    if (!field || field.value === value) return
    const selection = !ownerChanged && field.ownerDocument.activeElement === field
      ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection }
      : null
    field.value = value
    if (selection && selection.start !== null && selection.end !== null) {
      field.setSelectionRange(
        Math.min(selection.start, value.length),
        Math.min(selection.end, value.length),
        selection.direction ?? undefined,
      )
    }
  }, [fieldRef, value, owner])
  return initialValue.current
}
