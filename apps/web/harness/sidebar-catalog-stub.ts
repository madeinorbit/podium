/** The synthetic sidebar has no server/provider. Marks and pickers use their
 * normal bundled fallback; no descriptor/catalog requests or background refresh. */
export function useHarnessDescriptors() {
  return { served: undefined, status: 'unavailable' as const }
}
export function useModelCatalogState() {
  return { catalog: {}, status: 'unavailable' as const }
}
export function useModelCatalog() {
  return {}
}
