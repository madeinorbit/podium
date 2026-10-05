import { blockingCloseConcerns, issueCloseConcernsFromCounts } from '@podium/client-core/values'
import { issuePages } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback } from 'react'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'

/** One task's maintained scalar facts, without reading its session roster. */
export function readIssueCloseConcerns(pool: MobxPool, id: string) {
  const facts = issuePages(pool).closeFacts(id)
  return !facts || facts === LOADING ? LOADING :
    blockingCloseConcerns(issueCloseConcernsFromCounts(facts.subject, facts.members))
}

/** A close press reads current facts; mounting a menu retains no demand. */
export function useIssueCloseGuard() {
  const pool = useMobilePool()
  return useCallback((id: string): boolean => {
    const concerns = pool ? readIssueCloseConcerns(pool, id) : LOADING
    return concerns === LOADING || concerns.length > 0
  }, [pool])
}

/** Only the visible confirmation body observes these addressed facts. */
export function useIssueCloseConcerns(id: string) {
  const read = useCallback((pool: MobxPool) => readIssueCloseConcerns(pool, id), [id])
  return useMobilePoolProjection(read, LOADING as ReturnType<typeof read>)
}
