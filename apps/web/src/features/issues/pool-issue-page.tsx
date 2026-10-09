import { type PageIssue } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { IssuePageBody } from './IssuePage'
import { IssuePanelBody } from './IssuePanelView'
import { IssueExplorerList } from './explorer/IssueExplorerList'
import { IssuePageContext } from './issue-page/issue-page-data'
import { IssueViewsContext, useIssueViews } from './issue-page/opening-context'
import { useEvictionPresenceGuard } from './issue-page/use-eviction-guard'

export function PoolIssuePage({
  issueId,
  ...props
}: Omit<ComponentProps<typeof IssuePageBody>, 'issue'> & { issueId: string }) {
  const pool = useWorklistPool()
  const views = useIssueViews()
  const read = useCallback((_owner: MobxPool) => views?.issue(issueId), [views, issueId])
  const data = useWorklistPoolProjection<Loaded<PageIssue>>(read, undefined)
  useEvictionPresenceGuard(
    issueId,
    !pool || typeof data === 'symbol' ? null : Boolean(data),
    props.onBack,
  )
  if (!views || !pool || !data || typeof data === 'symbol') return null
  return (
    <IssueViewsContext.Provider value={views}>
      <IssuePageContext.Provider value={{ issue: data, views }}>
        <IssuePageBody issue={data} {...props} />
      </IssuePageContext.Provider>
    </IssueViewsContext.Provider>
  )
}

export function PoolIssuePanelView(props: ComponentProps<typeof IssuePanelBody>) {
  const pool = useWorklistPool()
  const views = useIssueViews()
  const { cwd, issueId, sessionId } = props
  const read = useCallback(
    (_owner: MobxPool) => views?.panelIssue({ cwd, issueId, sessionId }),
    [views, cwd, issueId, sessionId],
  )
  const data = useWorklistPoolProjection<Loaded<PageIssue>>(read, undefined)
  if (!views || !pool || typeof data === 'symbol') return null
  if (!data)
    return (
      <IssueViewsContext.Provider value={views}>
        <PoolIssueExplorerList />
      </IssueViewsContext.Provider>
    )
  return (
    <IssueViewsContext.Provider value={views}>
      <IssuePageContext.Provider value={{ issue: data, views }}>
        <IssuePanelBody {...props} />
      </IssuePageContext.Provider>
    </IssueViewsContext.Provider>
  )
}

function PoolIssueExplorerList() {
  return <IssueExplorerList />
}
