/** DOM-only clipboard/drag inspection (paste, drop), so it stays in apps/web
 *  rather than the shared client-core viewmodels. */

/** Returns true when a DataTransferItemList contains at least one image item. */
export function hasImageItems(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.type.startsWith('image/')) return true
  }
  return false
}

/**
 * Returns true when a DataTransferItemList carries at least one FILE.
 *
 * `kind` and not `type` is the whole point (POD-1203). Widening attachments past
 * screenshots means the composer can no longer decide by mime — a PDF, a CSV and
 * a `.md` have nothing in common to match on. But it must still keep its hands
 * off an ordinary text paste, and that is exactly what `kind` separates:
 * copied text arrives as `'string'` items, a file dragged out of Finder or
 * copied in a file manager arrives as `'file'`. Matching on `kind` lets the
 * composer intercept every attachment and no prose.
 */
export function hasFileItems(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.kind === 'file') return true
  }
  return false
}
