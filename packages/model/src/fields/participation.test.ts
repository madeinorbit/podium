/**
 * PARTICIPATION IS NOT A GRANT, AND A WATERMARK IS NOT A CAPABILITY — A2.
 *
 * Two shapes land together in this issue and both have a near neighbour they must
 * not be mistaken for. The tests are about the distance between them, because
 * that distance is the entire reason each shape exists:
 *
 *   - {@link TaskParticipation} sits beside the GRANT EDGE and must confer
 *     nothing. Every active member already reads every task and already holds
 *     ordinary edit (ADR 9 Amendment 1 D4/D5), so a collaborator row has no right
 *     left to give — and if it ever gives one, the system has a second
 *     authorization vocabulary that `GrantEdgeVisibilityPolicy` does not read and
 *     no audit covers.
 *   - {@link RevisionRef} sits beside a CAPABILITY SNAPSHOT and must stay a
 *     version counter. Holding one lets a worker notice that truth moved; it must
 *     never let one act on rights it no longer has (D5 A1).
 */

import { describe, expect, it } from 'vitest'
import { legacyAttributionViolations } from './attribution-legacy'
import { Attribution } from './attribution'
import { Ownership } from './ownership'
import {
  PARTICIPATION_ROLES,
  participationRoleIsBuilt,
  TaskParticipation,
} from './participation'
import {
  accountRevision,
  configurationRevision,
  revisionIsCurrent,
  RevisionRef,
  sameSubject,
  taskRevision,
} from './revision-ref'

const participation = {
  issueId: 'iss_1',
  userId: 'mem_a',
  role: 'collaborator',
  joinedAt: '2026-09-12T00:00:00Z',
  addedBy: { actor: { kind: 'user', id: 'mem_a' }, onBehalfOf: 'mem_a' },
}

describe('task participation describes; it does not authorize', () => {
  it('carries no verb, no scope and no expiry', () => {
    // The structural claim. A grant is `(entityRef, grantee, verb)`; strip the
    // verb and there is nothing for a policy to evaluate, which is the point.
    // Asserted as the WHOLE key set so a later addition has to come through here.
    expect(Object.keys(TaskParticipation.shape).sort()).toEqual(
      ['addedBy', 'issueId', 'joinedAt', 'role', 'userId'].sort(),
    )
  })

  it('records WHO added WHOM, as the one shared attribution pair', () => {
    // A person joining themselves and an agent recording its own human are
    // different facts, and only the pair tells them apart. It matters next door:
    // D2 lets any active member reassign and never lets an agent do it, and a
    // participation write is what an agent's claim IS allowed to do.
    expect(TaskParticipation.shape.addedBy).toBe(Attribution)
    expect(TaskParticipation.parse(participation).addedBy.onBehalfOf).toBe('mem_a')
  })

  it('names a HUMAN, never an agent label', () => {
    // The same rule that keeps `owner` a person (ADR 9 D5 A4). An agent
    // participates through the human it acts for; an `agent:<kind>` string in the
    // user position is the defect A2 retired from `issues.assignee`, and there is
    // no reason to reintroduce it one table over.
    //
    // `UserIdField` is length-only, so this cannot be a claim about what PARSES —
    // `agent:claude` is a well-formed string under any spelling of the brand. It is
    // a claim about the CONTRACT, and the instrument is reference identity: this
    // key is the same schema instance the accountable owner is, so the two cannot
    // drift into different id spaces without one of them being redefined.
    // And the brand does NOT parse-check the value — `UserIdField` is
    // `z.string().brand<'UserId'>()` with no length rule, so `agent:claude` and ''
    // both parse here exactly as they parsed in the retired `issues.assignee`
    // column. That is the point of asserting identity instead: the guarantee is
    // that this key cannot drift into a different id space from the accountable
    // owner, not that either one validates.
    expect(TaskParticipation.shape.userId).toBe(Ownership.shape.owner)
    expect(TaskParticipation.safeParse({ ...participation, userId: 'agent:x' }).success).toBe(true)
  })

  it('declares `follower` without building it', () => {
    // PDM-208 (task following/mute) is deferred out of v1 by the accepted decision
    // table. The member is declared so that the day following ships is not also
    // the day this table changes shape — the same trade `CREDENTIAL_SOURCES` makes
    // for a one-member enum. `participationRoleIsBuilt` is what keeps "reserved"
    // from drifting into "half-implemented".
    expect([...PARTICIPATION_ROLES]).toEqual(['collaborator', 'follower'])
    expect(participationRoleIsBuilt('collaborator')).toBe(true)
    expect(participationRoleIsBuilt('follower')).toBe(false)
  })

  it('passes the legacy-attribution audit — it names the shared pair', () => {
    // The repo's own instrument for "is this attribution the real one or a
    // lookalike". Running it here means a future edit that inlines an
    // `{ actor, onBehalfOf }` object rather than composing `Attribution` is
    // caught by the sweep that already exists rather than by review.
    expect(legacyAttributionViolations()).toEqual([])
  })
})

describe('revision references are typed by subject', () => {
  const task = taskRevision('iss_1' as never, 4)
  const account = accountRevision('mem_a' as never, 4)

  it('refuses to compare two different subjects that share a number', () => {
    // The failure a bare `revision: number` cannot prevent: two watermarks read
    // off two different rows, identical as values, compared without complaint.
    expect(sameSubject(task, account)).toBe(false)
    expect(revisionIsCurrent(task, account)).toBe(false)
  })

  it('answers NO for a malformed comparison rather than yes', () => {
    // Default-closed, the same discipline ADR 9 D4 applies to visibility: a caller
    // comparing against the wrong row has a bug, and the safe answer to "may I act
    // on this?" when the question is malformed is no.
    expect(revisionIsCurrent(task, taskRevision('iss_other' as never, 4))).toBe(false)
    expect(revisionIsCurrent(task, taskRevision('iss_1' as never, 4))).toBe(true)
  })

  it('treats a BEHIND current value as not-current, not as safely ahead', () => {
    // Strict equality rather than `>=`. A `current` behind the reference is a
    // replica that has not caught up or a reference that was never real — and
    // admitting either is how a stale write gets past the check meant to stop it.
    expect(revisionIsCurrent(task, taskRevision('iss_1' as never, 3))).toBe(false)
    expect(revisionIsCurrent(task, taskRevision('iss_1' as never, 5))).toBe(false)
  })

  it('distinguishes configuration scopes and their singleton/object split', () => {
    const instance = configurationRevision('instance-settings', null, 2)
    const profile = configurationRevision('execution-profile', 'prof_1', 2)
    expect(sameSubject(instance, profile)).toBe(false)
    expect(revisionIsCurrent(instance, configurationRevision('instance-settings', null, 2))).toBe(
      true,
    )
  })

  it('parses only the three declared subjects', () => {
    expect(RevisionRef.safeParse(task).success).toBe(true)
    expect(RevisionRef.safeParse({ kind: 'machine', id: 'mac_1', revision: 1 }).success).toBe(false)
  })

  it('holds a version, never a decision', () => {
    // The capability-snapshot boundary (D5 A1). A reference carries a subject and
    // a number; anything named for an ANSWER — rights, capabilities, role, grants —
    // would make it a frozen authorization result with no cleanup trigger.
    for (const ref of [task, account, configurationRevision('instance-settings', null, 1)]) {
      expect(Object.keys(ref)).not.toContain('role')
      expect(Object.keys(ref)).not.toContain('grants')
      expect(Object.keys(ref)).not.toContain('capabilities')
      expect(ref.revision).toBeTypeOf('number')
    }
  })
})
