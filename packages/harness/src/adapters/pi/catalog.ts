/**
 * Pi's static catalog (POD-4475): NO static model list — pi's catalog spans
 * many providers and is live-enumerated via `pi --list-models` (until then
 * the picker offers Auto + free text). The `--thinking` ladder is static.
 */

import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

export const piCatalog: HarnessCatalogData = {
  kind: 'pi',
  models: [],
  efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
