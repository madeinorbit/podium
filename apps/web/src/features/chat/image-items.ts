/** Returns true when a DataTransferItemList contains at least one image item.
 *  A DOM-only check (paste/drop), so it stays in apps/web rather than the
 *  shared client-core viewmodels. */
export function hasImageItems(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.type.startsWith('image/')) return true
  }
  return false
}
