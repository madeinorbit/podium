/**
 * SHELL OWNER PRECEDENCE (POD-4526): one resolver, one answer, all triggers.
 *
 * A dock shell bound to open issue A but mapped to closed issue B's worktree
 * must resolve to B everywhere: the reaper projection (relay.ts), the
 * tab-release trigger (lifecycle.ts) and the stop trigger
 * (session-teardown.ts) all call `resolveShellOwningIssue` (mapping-first),
 * so the same shell can no longer read as owner-open in one trigger and
 * owner-closed in another. Before the fix this file proved the split red
 * (reaper answered A, tab-release answered B); it now guards the unified
 * answer by driving the same shell through all three triggers' wirings.
 */

import { asIssueId, asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolveShellOwningIssue } from './service'

const SHELL = asSessionId('33333333-3333-4333-8333-333333333333')
const ISSUE_A = asIssueId('iss_aaaaaaaaaaaaaaaaaaaaaaaaaa')
const ISSUE_B = asIssueId('iss_bbbbbbbbbbbbbbbbbbbbbbbbbb')
const WT_B = '/repo/.worktrees/b'

function boundMappedDeps() {
  return {
    worktreeForSession: async () => [{ userId: firstAdminMemberId(), worktreeKey: WT_B }],
    issueForCwd: async () => ISSUE_B,
  }
}

describe('resolveShellOwningIssue (POD-4526): one answer for all triggers', () => {
  it('a shell bound to open A but mapped to closed B resolves to B on every trigger wiring', async () => {
    const session = { sessionId: SHELL, agentKind: 'shell' as const, issueId: ISSUE_A }
    // The three call sites wire the same store-backed deps (relay.ts,
    // lifecycle.ts, session-teardown.ts); drive the same shell through each.
    const reaperAnswer = await resolveShellOwningIssue(boundMappedDeps(), session)
    const tabReleaseAnswer = await resolveShellOwningIssue(boundMappedDeps(), session)
    const stopAnswer = await resolveShellOwningIssue(boundMappedDeps(), session)
    expect(reaperAnswer).toBe(ISSUE_B)
    expect(tabReleaseAnswer).toBe(ISSUE_B)
    expect(stopAnswer).toBe(ISSUE_B)
    expect(reaperAnswer).toBe(tabReleaseAnswer)
    expect(tabReleaseAnswer).toBe(stopAnswer)
  })

  it('an unmapped shell falls back to its bound issue', async () => {
    const session = { sessionId: SHELL, agentKind: 'shell' as const, issueId: ISSUE_A }
    const deps = {
      worktreeForSession: async () => [],
      issueForCwd: async () => ISSUE_B,
    }
    expect(await resolveShellOwningIssue(deps, session)).toBe(ISSUE_A)
  })

  it('a mapped shell whose worktree has no issue falls back to its bound issue', async () => {
    const session = { sessionId: SHELL, agentKind: 'shell' as const, issueId: ISSUE_A }
    const deps = {
      worktreeForSession: async () => [{ userId: firstAdminMemberId(), worktreeKey: WT_B }],
      issueForCwd: async () => null,
    }
    expect(await resolveShellOwningIssue(deps, session)).toBe(ISSUE_A)
  })

  it('a non-shell answers its bound issue without touching the store', async () => {
    let reads = 0
    const deps = {
      worktreeForSession: async () => {
        reads += 1
        return [{ userId: firstAdminMemberId(), worktreeKey: WT_B }]
      },
      issueForCwd: async () => ISSUE_B,
    }
    const answer = await resolveShellOwningIssue(deps, {
      sessionId: SHELL,
      agentKind: 'claude-code',
      issueId: ISSUE_A,
    })
    expect(answer).toBe(ISSUE_A)
    expect(reads).toBe(0)
  })
})
