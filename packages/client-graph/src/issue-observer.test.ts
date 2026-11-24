import { observer } from 'mobx-react-lite'
import { expect, it } from 'vitest'
import { createIssueObserver } from './issue-observer'

const issueObserver = createIssueObserver(observer)
const Plain = () => null

it('refuses an observer() component when defined, not when rendered', () => {
  expect(() => issueObserver(Plain)).not.toThrow()
  expect(() => issueObserver(observer(Plain))).toThrow(/plain function components/)
  expect(() => issueObserver(Plain, observer(Plain))).toThrow(/plain function components/)
})
