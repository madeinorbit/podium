/** The model chip harness has no server (POD-6523): a small served catalog so
 *  the pickers label their values as an operator sees them, and the bundled
 *  harness descriptors. */
const catalog = {
  'claude-code': [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
  ],
}
export function useHarnessDescriptors() {
  return { served: undefined, status: 'unavailable' as const }
}
export function useModelCatalogState() {
  return { catalog, status: 'ready' as const }
}
export function useModelCatalog() {
  return catalog
}
