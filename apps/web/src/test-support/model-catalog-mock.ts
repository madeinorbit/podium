import type { ModelChoiceWire } from '@podium/protocol'
import { vi } from 'vitest'

type Catalog = Record<string, ModelChoiceWire[]>
type FixtureGlobal = typeof globalThis & {
  __podiumModelCatalogFixture?: { current: Catalog }
}

function fixtureState(): { current: Catalog } {
  const root = globalThis as FixtureGlobal
  return (root.__podiumModelCatalogFixture ??= { current: {} })
}

export const modelCatalogFixture = {
  get current(): Catalog {
    return fixtureState().current
  },
  set current(catalog: Catalog) {
    fixtureState().current = catalog
  },
}

vi.mock('@/lib/use-model-catalog', () => {
  const current = (): Catalog =>
    (globalThis as FixtureGlobal).__podiumModelCatalogFixture?.current ?? {}
  return {
    useModelCatalog: current,
    // A fixture with models reads as a probe that answered; an empty one as a
    // machine that has not reported (POD-3911: the picker then offers Auto only).
    useModelCatalogState: () => {
      const catalog = current()
      return { catalog, status: Object.keys(catalog).length > 0 ? 'ready' : 'unavailable' }
    },
  }
})

/**
 * Served harness descriptors fixture (POD-4475): provider-free tests render
 * pickers against the bundled descriptors. `served: undefined` exercises the
 * offline fallback path every suite already depends on.
 */
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' as const }),
}))
