/**
 * Fixture's static catalog (POD-4538): one named model on the shared effort
 * ladder, so picker paths through the fixture double have something to offer
 * without a live probe. Never served or bundled (the fixture is not in
 * AGENT_MANIFESTS); it exists so the fixture manifest satisfies totality.
 */

import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

export const fixtureCatalog: HarnessCatalogData = {
  kind: 'fixture' as BuiltinHarnessKind,
  models: [{ value: 'fixture-model', label: 'Fixture Model', efforts: ['low', 'medium'] }],
  efforts: ['low', 'medium'],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
