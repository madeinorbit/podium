import { createIssueObserver } from '@podium/client-graph/issue-observer'
import { observer } from 'mobx-react-lite'

// Bind to this app's React peer graph, including the phone test/native renderer.
export const issueObserver = createIssueObserver(observer)
