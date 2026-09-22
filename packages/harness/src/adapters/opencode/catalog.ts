/**
 * OpenCode's static model/effort catalog (POD-4475): the picker fallback
 * before the live probe (`opencode models`) answers. Per-model effort
 * metadata is unknown, so the `--variant` ladder applies.
 */

import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

export const opencodeCatalog: HarnessCatalogData = {
  kind: 'opencode',
  models: [
    { value: 'openai/gpt-5.5', label: 'OpenAI GPT-5.5' },
    { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'xai/grok-4.3', label: 'Grok 4.3' },
  ],
  efforts: ['minimal', 'low', 'medium', 'high', 'max'],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
