import { describe, expect, it } from 'vitest'
import {
  ALL_ISSUE_STAGES,
  type IssueStage,
  isIssueStage,
  isReadyIssueStage,
  isSystemOwnedIssueStage,
} from './issue-vocabulary'

type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never

const _systemOwnedStaysNarrow: Exact<Parameters<typeof isSystemOwnedIssueStage>[0], IssueStage> =
  true
const _readyStaysNarrow: Exact<Parameters<typeof isReadyIssueStage>[0], IssueStage> = true
void _systemOwnedStaysNarrow
void _readyStaysNarrow

describe('issue stage vocabulary', () => {
  it('narrows stored strings onto the durable stage union', () => {
    expect(ALL_ISSUE_STAGES.every(isIssueStage)).toBe(true)
    expect(isIssueStage('shipping')).toBe(true)
    expect(isIssueStage('bogus')).toBe(false)
    expect(isIssueStage(undefined)).toBe(false)
  })

  it('keeps shipping as system-owned custody and out of ready queues', () => {
    expect(isSystemOwnedIssueStage('shipping')).toBe(true)
    expect(isReadyIssueStage('shipping')).toBe(false)
    expect(isReadyIssueStage('proposed')).toBe(false)
    expect(isReadyIssueStage('review')).toBe(true)
    expect(isReadyIssueStage('in_progress')).toBe(true)
  })
})
