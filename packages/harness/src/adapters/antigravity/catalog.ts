import {
  type HarnessCatalogData,
  LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
} from '../../descriptor-types.js'

/** Models are account-dependent; enumerate agy models rather than inventing aliases. */
export const antigravityCatalog: HarnessCatalogData = {
  kind: 'antigravity',
  models: [],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  liveMerge: LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY,
}
