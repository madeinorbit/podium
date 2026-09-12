/**
 * THE PERSONAL SIDEBAR ROW — three cases, and the one with no field (A2).
 *
 * ADR 9 Amendment 1 D3 makes three statements about how a task reaches a person's
 * sidebar, and they are deliberately three different shapes here:
 *
 *   - an explicit START adds a PERMANENT row → `startedAt`, per-user;
 *   - an ASSIGNMENT adds a REMOVABLE badged row → derived from the shared owner
 *     plus this reader's `assignmentDismissedAt`;
 *   - DISCOVERY adds NOTHING → no field at all.
 *
 * The third is the one worth testing, and the reason is the rest of this epic:
 * once ADR 9 Amendment 1 D4 lets every active member read every task, a sidebar
 * that grew a row on read would be every task, for everyone, immediately. The
 * absent field is what makes that impossible rather than merely unimplemented.
 */

import { describe, expect, it } from 'vitest'
import { PER_USER_STATE_KEYS } from '../aggregates/registry'
import { IssueAggregate } from '../aggregates/issue'
import { IssueUserState, personalSidebarRowOf } from './issue-state'

const none = { isAssignee: false, startedAt: null, assignmentDismissedAt: null }

describe('personal sidebar row', () => {
  it('adds nothing for a task this person has merely read', () => {
    expect(personalSidebarRowOf(none)).toBe('none')
  })

  it('adds a removable row for the person a task is assigned to', () => {
    expect(personalSidebarRowOf({ ...none, isAssignee: true })).toBe('assigned')
    expect(
      personalSidebarRowOf({ ...none, isAssignee: true, assignmentDismissedAt: '2026-09-12T00:00:00Z' }),
    ).toBe('none')
  })

  it('keeps an explicit start after the person stops being the assignee', () => {
    // "Explicit starts add a permanent row" (D3). The whole point of the word
    // permanent is that it survives a reassignment — work you said was yours does
    // not leave your sidebar because somebody else became accountable for it.
    expect(personalSidebarRowOf({ ...none, startedAt: '2026-09-12T00:00:00Z' })).toBe('started')
  })

  it('ranks a start above a dismissed assignment', () => {
    // Both inputs present and disagreeing. A dismissed assignment is not a reason
    // to drop work you started; ordering the two is what stops the dismissal from
    // silently clearing the permanent row.
    expect(
      personalSidebarRowOf({
        isAssignee: true,
        startedAt: '2026-09-12T00:00:00Z',
        assignmentDismissedAt: '2026-09-12T01:00:00Z',
      }),
    ).toBe('started')
  })
})

describe('the markers are per-USER, structurally', () => {
  it('keys every marker by the shared (userId, entityId) fragment', () => {
    // `perUserKey(IssueIdField)` — the ONE key fragment (ADR 4 Amendment 1 D10),
    // so the entity half stays branded without a second spelling of the user half.
    const keys = Object.keys(IssueUserState.shape)
    expect(keys).toContain('userId')
    expect(keys).toContain('entityId')
    expect(keys).toContain('startedAt')
    expect(keys).toContain('assignmentDismissedAt')
  })

  it('keeps them OFF the shared task row', () => {
    // The failure mode is specific and has happened here before: `tuckedAt` was a
    // column on `issues` until POD-1076, so one operator's fold was everyone's —
    // invisible while there was one operator. `startedAt` would repeat it exactly
    // ("when work began" reads like a fact about the task until you ask whose),
    // and `assignmentDismissedAt` would let one person's dismissal hide the task
    // from the next person it is assigned to.
    const shared = Object.keys(IssueAggregate.shape)
    expect(shared).not.toContain('startedAt')
    expect(shared).not.toContain('assignmentDismissedAt')
    // And they are in the registry's guard list, so the check runs over every
    // canonical aggregate rather than only over this assertion.
    expect([...PER_USER_STATE_KEYS]).toContain('startedAt')
    expect([...PER_USER_STATE_KEYS]).toContain('assignmentDismissedAt')
  })

  it('spells "this person has done nothing" as an absent row, not as nulls', () => {
    // Every marker nullable, and the storage deletes an all-null row — so absence
    // keeps a single meaning. Adding two markers did not change that rule; it made
    // the emptiness test have to count more, which is why the store reads it off
    // the object rather than from a remembered list of three.
    const empty = IssueUserState.parse({
      userId: 'mem_a',
      entityId: 'iss_1',
      readAt: null,
      tuckedAt: null,
      pinnedAt: null,
      startedAt: null,
      assignmentDismissedAt: null,
    })
    expect(Object.values(empty).filter((v) => v === null)).toHaveLength(5)
  })
})
