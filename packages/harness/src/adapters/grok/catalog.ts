/**
 * Grok's static model/effort catalog (POD-4475): the picker fallback before
 * the live probe (`grok models`) answers. Per-model effort metadata is
 * unknown (grok does not expose it), so the harness ladder applies.
 */

import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

export const grokCatalog: HarnessCatalogData = {
  kind: 'grok',
  models: [
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'grok-composer-2.5-fast', label: 'Composer 2.5 Fast' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
