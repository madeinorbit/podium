/** The model chip harness has no server (POD-6523): a small served catalog so
 *  the pickers label their values as an operator sees them, and the bundled
 *  harness descriptors. */
const catalog = {
  codex: [
    { value: 'gpt-5-codex', label: 'Codex A', efforts: ['low', 'high'] },
    { value: 'gpt-5.1-codex-max', label: 'Codex B', efforts: ['low', 'high'] },
  ],
  grok: [
    { value: 'grok-4.5', label: 'Grok 4.5', efforts: ['low', 'high'] },
    { value: 'grok-4.6', label: 'Grok 4.6', efforts: ['low', 'high'] },
  ],
  opencode: [
    { value: 'anthropic/claude-sonnet-4', label: 'Sonnet', efforts: ['low', 'high'] },
    { value: 'anthropic/claude-opus-4-1', label: 'Opus', efforts: ['low', 'high'] },
  ],
  pi: [
    { value: 'fake/model-a', label: 'Pi A', efforts: ['low', 'high'] },
    { value: 'fake/model-b', label: 'Pi B', efforts: ['low', 'high'] },
  ],
  cursor: [
    { value: 'sonnet-thinking-low', label: 'Sonnet Low', efforts: ['low', 'high'] },
    { value: 'sonnet-thinking-high', label: 'Sonnet High', efforts: ['low', 'high'] },
    { value: 'opus-thinking-low', label: 'Opus Low', efforts: ['low', 'high'] },
    { value: 'opus-thinking-high', label: 'Opus High', efforts: ['low', 'high'] },
  ],
  'claude-code': [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
  ],
}
export function useHarnessDescriptors() {
  return { served: undefined, status: 'unavailable' as const }
}
export function useModelCatalogState() {
  const state = new URLSearchParams(window.location.search).get('catalog')
  if (state === 'unavailable' || state === 'loading') {
    return { catalog: {} as typeof catalog, status: state }
  }
  return { catalog, status: 'ready' as const }
}
export function useModelCatalog() {
  return catalog
}
