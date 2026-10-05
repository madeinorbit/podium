import type { MobxPool } from '@podium/client-graph'
import { createTerminalReferences } from '@podium/client-graph/terminal-references'

/** The terminal declares only its painted tokens; source-owned identity roots
 * answer first demand without constructing the resident reference catalog. */
export function createPaneReferenceStages(pool: MobxPool) {
  return createTerminalReferences(pool)
}
