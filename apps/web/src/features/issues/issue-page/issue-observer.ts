import { createIssueObserver } from '@podium/client-graph/issue-observer'
import { observer } from 'mobx-react-lite'

export const issueObserver = createIssueObserver(observer)
