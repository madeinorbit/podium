/**
 * Codex's static model/effort catalog (POD-4475): the picker fallback before
 * the live probe answers. The fallback only — codex is live-enumerated
 * server-side via `codex debug models`, which replaces this when non-empty.
 * The frontier line carries rungs older models do not; per-model efforts are
 * authoritative where present.
 */

import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

const EFFORT = ['low', 'medium', 'high', 'xhigh']
const EFFORT_56 = [...EFFORT, 'max']
const EFFORT_56_FRONTIER = [...EFFORT_56, 'ultra']

export const codexCatalog: HarnessCatalogData = {
  kind: 'codex',
  models: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: [...EFFORT_56_FRONTIER] },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: [...EFFORT_56_FRONTIER] },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: [...EFFORT_56] },
    { value: 'gpt-5.5', label: 'GPT-5.5', efforts: [...EFFORT] },
    { value: 'gpt-5.4', label: 'GPT-5.4', efforts: [...EFFORT] },
  ],
  efforts: [...EFFORT],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
