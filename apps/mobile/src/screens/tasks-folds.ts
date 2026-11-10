import { MOBILE_TASK_FOLDED_BY_DEFAULT } from '@podium/client-graph/mobile-screens-schema'
import type { IssueBoardStage } from '@podium/model'
import { useCollapsed } from '../hooks/useCollapsed'
import { stageFoldKey } from '../lib/fold-keys'

/**
 * The six stage folds, read up front: hooks cannot run in a loop over a
 * variable-length list. Keys come from `../lib/fold-keys` (the ui-state
 * classifier throws on an unregistered key); the defaults are the shared
 * board's `MOBILE_TASK_FOLDED_BY_DEFAULT`.
 */
export function useStageFolds(): Record<IssueBoardStage, [boolean, () => void]> {
  const fold = (stage: IssueBoardStage) =>
    // biome-ignore lint/correctness/useHookAtTopLevel: called a fixed six times, in a fixed order
    useCollapsed(stageFoldKey(stage), MOBILE_TASK_FOLDED_BY_DEFAULT[stage])
  return {
    in_progress: fold('in_progress'),
    review: fold('review'),
    planning: fold('planning'),
    backlog: fold('backlog'),
    proposed: fold('proposed'),
    done: fold('done'),
  }
}
