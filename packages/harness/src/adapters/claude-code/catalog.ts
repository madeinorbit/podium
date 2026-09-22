/**
 * Claude Code's static model/effort catalog (POD-4475): the picker fallback
 * before the live probe answers. Values are what the CLI accepts
 * (`claude --help` effort ladder; `--model` aliases); the live
 * `modelProbeRequest` result replaces them when non-empty.
 */

import type { HarnessCatalogData } from '../../descriptor-types.js'
import { LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY } from '../../descriptor-types.js'

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']

export const claudeCodeCatalog: HarnessCatalogData = {
  kind: 'claude-code',
  models: [
    { value: 'opus', label: 'Opus', efforts: [...EFFORT] },
    { value: 'sonnet', label: 'Sonnet', efforts: [...EFFORT] },
    { value: 'haiku', label: 'Haiku', efforts: [] },
  ],
  efforts: [...EFFORT],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
