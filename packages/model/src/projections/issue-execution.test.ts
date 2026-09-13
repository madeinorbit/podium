/**
 * THE GATE FOR THE OWNER-SCOPED EXECUTION SIDECAR — B4 (PDM-136).
 *
 * WHAT A GREEN HERE DOES AND DOES NOT MEAN. It means the two halves of the split
 * are TOTAL over the projection and that the join is the inverse of the split.
 * It does NOT mean the private half is delivered only to owners — that is a
 * property of `apps/server/src/feed-visibility.ts`'s `mayRead` arm, witnessed by
 * `feed-visibility.test.ts`'s "admits the owner and refuses a read-grantee of
 * the very same issue" and proved there by deliberate break. Said out loud
 * because a file named for a privacy mechanism is exactly where a reader would
 * assume the privacy was tested.
 */

import { describe, expect, it } from 'vitest'
import { actorUser } from '../fields/attribution'
import { asUserId } from '../ids'
import { IssueProjection } from './issue-projection'
import {
  IssueExecutionProjection,
  joinIssueExecution,
  toExecutionWire,
} from './issue-execution'
import {
  ISSUE_PRIVATE_EXECUTION_KEYS,
  SharedIssueProjection,
  SharedIssueWire,
  toSharedWire,
} from './issue-shared'

describe('the owner-scoped execution sidecar [PDM-136]', () => {
  it('carries exactly the private keys, plus the issue id it is keyed by', () => {
    // DERIVED from the shipped schema, never retyped: a restated list here would
    // be a second copy of the assumption under test (catalogue shape 7).
    expect(Object.keys(IssueExecutionProjection.shape).sort()).toEqual(
      ['issueId', ...ISSUE_PRIVATE_EXECUTION_KEYS].sort(),
    )
  })

  it('splits an issue into two halves that are total and disjoint', () => {
    // The non-vacuity guard for everything below: if the private list were empty
    // the shared half would be the whole projection and every absence assertion
    // in this file would be a claim about nothing (catalogue shape 9).
    expect(ISSUE_PRIVATE_EXECUTION_KEYS.length).toBeGreaterThan(0)

    const full = fullIssue()
    const shared = toSharedWire(full)
    const execution = toExecutionWire(full)

    const sharedKeys = Object.keys(shared)
    const executionKeys = Object.keys(execution).filter((key) => key !== 'issueId')

    // DISJOINT: no key is on both halves.
    expect.soft(sharedKeys.filter((key) => executionKeys.includes(key))).toEqual([])
    // TOTAL: together they are the projection. This is the assertion that fails
    // if a future field lands on `IssueAggregate` and reaches neither half.
    expect.soft([...sharedKeys, ...executionKeys].sort()).toEqual(Object.keys(full).sort())
  })

  it('actually moves the values, in both directions', () => {
    // ONE fixture asserted both ways. Absence-only would pass against a sidecar
    // that carried nothing; presence-only would pass against a shared payload
    // that dropped nothing.
    const full = fullIssue()
    const execution = toExecutionWire(full)

    expect.soft(execution.issueId).toBe(full.id)
    expect.soft(execution.worktreePath).toBe('/home/someone/repo/.worktrees/issue-1')
    expect.soft(execution.machineId).toBe('m_someone_laptop')
    expect.soft(execution.coordinatorSessionId).toBe('ses_private')
    expect.soft(execution.startedBySession).toBe('ses_private_too')

    for (const key of ISSUE_PRIVATE_EXECUTION_KEYS) {
      expect.soft(toSharedWire(full)).not.toHaveProperty(key)
    }
  })

  it('is the inverse of the split: shared + sidecar reconstitutes the issue', () => {
    // This is what pays for the removal. The OWNER must end up with the row they
    // had before, or the split is a regression dressed as a fix.
    const full = fullIssue()
    const rejoined = joinIssueExecution(toSharedWire(full), toExecutionWire(full))
    expect(IssueProjection.parse(rejoined)).toEqual(full)
  })

  it('leaves the shared half alone when there is no sidecar', () => {
    // The ordinary case for a non-owner, and it must be a renderable task rather
    // than an error or a row with four `undefined` holes punched in it.
    const shared = toSharedWire(fullIssue())
    const joined = joinIssueExecution(shared, undefined)
    expect.soft(joined).toEqual(shared)
    for (const key of ISSUE_PRIVATE_EXECUTION_KEYS) {
      expect.soft(joined).not.toHaveProperty(key)
    }
  })

  it('strips a private key a caller tries to smuggle back onto a shared payload', () => {
    // A property of the schema, not of a loop body: zod drops unknown keys, so a
    // producer cannot reattach one by spreading. Asserted for the LEGACY wire as
    // well as the projection, because PDM-387's brief named only the projection
    // and `IssueWire` is the second door with the same predicate behind it.
    const smuggled = { ...fullIssue(), worktreePath: '/home/someone/secret' }
    expect.soft(SharedIssueProjection.parse(smuggled)).not.toHaveProperty('worktreePath')
    expect.soft(Object.keys(SharedIssueWire.shape)).not.toContain('worktreePath')
    expect.soft(Object.keys(SharedIssueWire.shape)).not.toContain('machineId')
    expect.soft(Object.keys(SharedIssueWire.shape)).not.toContain('coordinatorSessionId')
    expect.soft(Object.keys(SharedIssueWire.shape)).not.toContain('startedBySession')
  })
})

/** A projection with EVERY private key set. A fixture that left one unset would
 *  make the disjointness check pass for the wrong reason — an absent key is on
 *  neither half, which looks exactly like a key that was correctly moved. */
function fullIssue(): IssueProjection {
  return IssueProjection.parse({
    id: 'iss_1',
    seq: 1,
    title: 'A task two people can both read',
    description: { value: 'shared content' },
    stage: 'backlog',
    priority: 2,
    type: 'task',
    labels: [],
    archived: false,
    needsHuman: false,
    branch: 'issue/1-a-shared-line-of-development',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'claude-opus-5',
    defaultEffort: 'high',
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
    blockedByNotes: [],
    owner: 'user_owner',
    visibility: 'personal',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    createdBy: { actor: actorUser(asUserId('user_owner')), onBehalfOf: asUserId('user_owner') },
    worktreePath: '/home/someone/repo/.worktrees/issue-1',
    machineId: 'm_someone_laptop',
    coordinatorSessionId: 'ses_private',
    startedBySession: 'ses_private_too',
  })
}
