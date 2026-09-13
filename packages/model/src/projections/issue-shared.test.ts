/**
 * THE GATE FOR THE SHARED ISSUE PROJECTION — B3 (PDM-135).
 *
 * `fields/README.md` rule 2: "A projection that must omit a field omits it, and
 * the golden fixtures for that projection are the gate — not this file." This is
 * that gate.
 *
 * WHAT A GREEN HERE DOES AND DOES NOT MEAN. It means the classification is total
 * over the projection's real key set and that the shared shape drops exactly the
 * four private keys. It does NOT mean the broadcast payload is safe: the feed
 * still carries `IssueProjection`, and nothing in this package can change that.
 * See `issue-shared.ts`'s header. Said here as well as there because a test file
 * is where someone checks whether a property holds, and this one would otherwise
 * imply a property it does not test.
 */

import { describe, expect, it } from 'vitest'
import { actorUser } from '../fields/attribution'
import { asUserId } from '../ids'
import { IssueProjection } from './issue-projection'
import {
  ISSUE_PRIVATE_EXECUTION_KEYS,
  SHARED_ISSUE_KEYS,
  SharedIssueProjection,
  toSharedWire,
} from './issue-shared'

/** Every key the projection actually has, read from the shipped schema rather
 *  than retyped — the reference has to be DERIVED or it is a second copy of the
 *  assumption under test (catalogue shape 7). */
const projectionKeys = Object.keys(IssueProjection.shape)

describe('the shared/private classification of IssueProjection [PDM-135]', () => {
  it('classifies every projection key exactly once', () => {
    // Totality. A field added to `IssueAggregate` lands in the shared half by
    // construction, so this is what makes that default a visible one: the counts
    // move together and the next test says which four names are on the other
    // side.
    const classified = [...SHARED_ISSUE_KEYS, ...ISSUE_PRIVATE_EXECUTION_KEYS]
    expect.soft([...classified].sort()).toEqual([...projectionKeys].sort())
    expect.soft(new Set(classified).size).toBe(classified.length)
  })

  it('pins the four private names, so a list that shrank cannot pass quietly', () => {
    // The non-vacuity guard for every derived assertion in this file (catalogue
    // shape 9): with the private list emptied, the totality test above still
    // passes and every absence assertion below becomes a claim about nothing.
    expect.soft([...ISSUE_PRIVATE_EXECUTION_KEYS]).toEqual([
      'worktreePath',
      'machineId',
      'coordinatorSessionId',
      'startedBySession',
    ])
    // And each one is really ON the projection. A private key naming a field
    // that does not exist would be removed from nothing, which is the same
    // defect as a missing entry and is invisible to the totality check if the
    // shape ever drops a key.
    for (const key of ISSUE_PRIVATE_EXECUTION_KEYS) {
      expect.soft(projectionKeys).toContain(key)
    }
  })

  it('drops the private keys and keeps the shared ones — both directions', () => {
    // ONE fixture, asserted in both directions. A test that only checked absence
    // would pass against a projection that had dropped everything; one that only
    // checked presence would pass against a projection that dropped nothing.
    const full = IssueProjection.parse({
      ...minimalIssue(),
      worktreePath: '/home/someone/repo/.worktrees/issue-1',
      branch: 'issue/1-a-shared-line-of-development',
      parentBranch: 'main',
      machineId: 'm_someone_laptop',
      coordinatorSessionId: 'ses_private',
      startedBySession: 'ses_private_too',
    })

    const shared = toSharedWire(full)

    for (const key of ISSUE_PRIVATE_EXECUTION_KEYS) {
      expect.soft(shared).not.toHaveProperty(key)
    }
    // The task's own content survives, including the two repository-identity
    // keys that are deliberately SHARED — see `issue-shared.ts` on why a branch
    // name is task content and an absolute worktree path is not.
    expect.soft(shared.title).toBe(full.title)
    expect.soft(shared.branch).toBe('issue/1-a-shared-line-of-development')
    expect.soft(shared.parentBranch).toBe('main')
  })

  it('refuses a private key smuggled back in by a caller', () => {
    // `toSharedWire` parses rather than deleting named keys, so this is a
    // property of the schema and not of a loop body. The check that matters is
    // that the value does not survive — zod strips unknown keys, so a caller
    // cannot reattach one by spreading.
    const smuggled = { ...minimalIssue(), worktreePath: '/home/someone/secret' }
    const shared = SharedIssueProjection.parse(smuggled)
    expect(shared).not.toHaveProperty('worktreePath')
  })
})

/** The required members of R4, spelled once. Deliberately minimal: this file is
 *  about which keys survive, never about what a valid issue looks like. */
function minimalIssue(): Record<string, unknown> {
  return {
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
  }
}
