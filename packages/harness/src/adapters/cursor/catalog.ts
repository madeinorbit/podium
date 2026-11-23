/**
 * Cursor's static model catalog (POD-4475): the picker fallback before the
 * live probe (`cursor-agent models`) answers. Per-model effort choices come
 * only from sibling variants in that account's live catalog.
 */

import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

export const cursorCatalog: HarnessCatalogData = {
  kind: 'cursor',
  models: [
    { value: 'composer-2.5', label: 'Composer 2.5' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'claude-opus-4-8-thinking-high', label: 'Claude Opus 4.8 Thinking' },
  ],
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none'],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
