/**
 * SHELL OWNER PRECEDENCE DISAGREEMENT (POD-4526, red proof).
 *
 * The SAME dock shell — bound to open issue A, mapped to closed issue B's
 * worktree — gets two owning issues depending on which trigger asks:
 * - reaper projection (relay.ts): bound wins (`session.issueId ?? dockOwners`),
 *   and only unbound shells even consult the mapping;
 * - tab-release (lifecycle.ts) / stop (session-teardown.ts): mapping wins
 *   (`dockOwner?.issueId ?? session.issueId`).
 *
 * This test drives that one shell through both precedence expressions (using
 * the production `resolveDockShellOwner`) and asserts they agree. It FAILS on
 * the current code (A vs B) — the attached red run. The fix introduces one
 * mapping-first resolver called by all three triggers; the file is then
 * rewritten to assert the unified answer (all B) and goes green.
 */

import { asIssueId, asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolveDockShellOwner } from './service'

const SHELL = asSessionId('33333333-3333-4333-8333-333333333333')
const ISSUE_A = asIssueId('iss_aaaaaaaaaaaaaaaaaaaaaaaaaa')
const ISSUE_B = asIssueId('iss_bbbbbbbbbbbbbbbbbbbbbbbbbb')
const WT_B = '/repo/.worktrees/b'

describe('shell owner precedence disagreement (POD-4526 red)', () => {
  it('the reaper and the tab-release trigger agree on the owning issue', async () => {
    const session = { sessionId: SHELL, agentKind: 'shell' as const, issueId: ISSUE_A }
    const deps = {
      worktreeForSession: async () => [{ userId: firstAdminMemberId(), worktreeKey: WT_B }],
      issueForCwd: async () => ISSUE_B,
    }
    const owner = await resolveDockShellOwner(deps, session)
    // Tab-release / stop precedence (lifecycle.ts, session-teardown.ts).
    const tabReleaseAnswer = owner?.issueId ?? session.issueId
    // Reaper precedence (relay.ts): bound wins; bound shells never consult
    // the mapping at all, so the answer is the bound issue unconditionally.
    const reaperAnswer = session.issueId ?? owner?.issueId
    expect(tabReleaseAnswer).toBe(ISSUE_B)
    expect(reaperAnswer).toBe(tabReleaseAnswer)
  })
})
