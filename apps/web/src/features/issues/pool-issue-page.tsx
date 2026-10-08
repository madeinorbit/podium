import { issuePages, type PageIssue } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { IssuePageBody } from './IssuePage'
import { IssuePanelBody } from './IssuePanelView'
import { IssueExplorerList } from './explorer/IssueExplorerList'
import { IssuePageDataContext } from './issue-page/issue-page-data'
import { useEvictionPresenceGuard } from './issue-page/use-eviction-guard'

export function PoolIssuePage({ issueId, ...props }: Omit<ComponentProps<typeof IssuePageBody>, 'issue'> & { issueId: string }) {
  const pool = useWorklistPool()
  const read = useCallback((owner: MobxPool) => issuePages(owner).issue(issueId), [issueId])
  const data = useWorklistPoolProjection<Loaded<PageIssue>>(read, undefined)
  useEvictionPresenceGuard(issueId, !pool || typeof data === 'symbol' ? null : Boolean(data), props.onBack)
  if (!pool || !data || typeof data === 'symbol') return null
  return <IssuePageDataContext.Provider value={{ issue: data, views: issuePages(pool) }}>
    <IssuePageBody issue={data} {...props} />
  </IssuePageDataContext.Provider>
}

export function PoolIssuePanelView(props: ComponentProps<typeof IssuePanelBody>) {
  const pool = useWorklistPool()
  const { cwd, issueId, sessionId } = props
  const read = useCallback((owner: MobxPool) => issuePages(owner).panelIssue({ cwd, issueId, sessionId }), [cwd, issueId, sessionId])
  const data = useWorklistPoolProjection<Loaded<PageIssue>>(read, undefined)
  if (!pool || typeof data === 'symbol') return null
  if (!data) return <PoolIssueExplorerList />
  return <IssuePageDataContext.Provider value={{ issue: data, views: issuePages(pool) }}>
    <IssuePanelBody {...props} />
  </IssuePageDataContext.Provider>
}

function PoolIssueExplorerList() {
  return <IssueExplorerList />
}
