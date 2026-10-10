import { expect, it } from 'vitest'
import { objectsBehind } from './mobx-graph'

class IssueModel {}
class SessionModel {}
class WorklistIssue { constructor(readonly issue: IssueModel) {} }
class WorklistSession { constructor(readonly session: SessionModel) {} }

it('counts shared records held by companions even without model computeds', () => {
  const issue = new IssueModel()
  const session = new SessionModel()
  const work = new WorklistIssue(issue)
  const seat = new WorklistSession(session)
  const issueField = { name_: 'WorklistIssue.placed', scope_: work }
  const root = { name_: 'pool.file.issue', observing_: [
    issueField,
    { name_: 'WorklistIssue.rank', scope_: work },
    { name_: 'SessionModel.activity', scope_: session },
    { name_: 'WorklistSession.present', scope_: seat },
  ] }
  expect(objectsBehind([root, root])).toEqual({
    WorklistIssue: 1, IssueModel: 1, WorklistSession: 1, SessionModel: 1,
  })
})

it('counts distinct objects with identical debug names and handles graph cycles', () => {
  const first = { name_: 'IssueModel.finished', scope_: new IssueModel(), observing_: [] as unknown[] }
  const second = { name_: first.name_, scope_: new IssueModel(), observing_: [first] }
  first.observing_.push(second)
  expect(objectsBehind([second])).toEqual({ IssueModel: 2 })
})
