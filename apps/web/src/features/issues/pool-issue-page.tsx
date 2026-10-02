import { issuePages, type IssuePageData } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { IssuePageBody } from './IssuePage'
import { IssuePanelBody } from './IssuePanelView'
import { IssueExplorerList } from './explorer/IssueExplorerList'
import { IssuePageDataContext, IssuePageWorldContext } from './issue-page/issue-page-data'

export function PoolIssuePage({ issueId, ...props }: Omit<ComponentProps<typeof IssuePageBody>, 'issue'> & { issueId: string }) {
  const pool = useWorklistPool()
  const read = useCallback((owner: MobxPool) => issuePages(owner).data(issueId), [issueId])
  const data = useWorklistPoolProjection<Loaded<IssuePageData>>(read, undefined)
  const seen = useRef<string | null>(null)
  const left = useRef<string | null>(null)
  useEffect(() => {
    if (data && typeof data !== 'symbol') { seen.current = issueId; left.current = null }
    else if (pool && data === undefined && seen.current === issueId && left.current !== issueId) {
      left.current = issueId
      props.onBack()
    }
  }, [pool, data, issueId, props.onBack])
  if (!pool || !data || typeof data === 'symbol') return null
  return <IssuePageDataContext.Provider value={{ data, views: issuePages(pool) }}>
    <IssuePageBody issue={data.issue} {...props} />
  </IssuePageDataContext.Provider>
}

export function PoolIssuePanelView(props: ComponentProps<typeof IssuePanelBody>) {
  const pool = useWorklistPool()
  const { cwd, issueId, sessionId } = props
  const read = useCallback((owner: MobxPool) => issuePages(owner).panel({ cwd, issueId, sessionId }), [cwd, issueId, sessionId])
  const data = useWorklistPoolProjection<Loaded<IssuePageData>>(read, undefined)
  if (!pool || typeof data === 'symbol') return null
  if (!data) return <PoolIssueExplorerList />
  return <IssuePageDataContext.Provider value={{ data, views: issuePages(pool) }}>
    <IssuePanelBody {...props} />
  </IssuePageDataContext.Provider>
}

function PoolIssueExplorerList() {
  const read = useCallback((owner: MobxPool) => issuePages(owner).explorer(), [])
  const data = useWorklistPoolProjection(read, undefined)
  if (!data || typeof data === 'symbol') return null
  return <IssuePageWorldContext.Provider value={data}><IssueExplorerList /></IssuePageWorldContext.Provider>
}
