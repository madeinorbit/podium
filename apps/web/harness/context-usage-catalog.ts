/** Invented picker labels for the isolated composer layout. */
const catalog = {
  codex: [
    { value: 'demo-pro', label: 'Demo Pro', efforts: ['low', 'high'] },
    { value: 'demo-small', label: 'Demo Small', efforts: ['low', 'high'] },
  ],
}
export const useModelCatalog = () => catalog
export const useModelCatalogState = () => ({ catalog, status: 'ready' as const })
export const useHarnessDescriptors = () => ({ served: undefined, status: 'unavailable' as const })
