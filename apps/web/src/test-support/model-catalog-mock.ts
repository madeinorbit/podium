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

vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () =>
    (globalThis as FixtureGlobal).__podiumModelCatalogFixture?.current ?? {},
}))
