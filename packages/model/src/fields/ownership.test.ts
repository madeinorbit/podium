/**
 * ONE ACCOUNTABLE HUMAN, AND NO SECOND SLOT — A2.
 *
 * The deliverable is stated as a property of the SHAPES rather than of a
 * validation rule: *"Make task accountability, agent ownership and personal state
 * representable without duplicate mutable owner fields."* So these tests are
 * structural. They do not check that the two owner fields agree; they check that
 * there is not a second one to disagree.
 *
 * Why that distinction is the whole issue. `issues.assignee` and
 * `issues.owner_user_id` both existed, both were mutable, and both answered "who
 * is accountable". Nothing kept them in step, and two live writers pushed them
 * apart — `claim` wrote the assignee half alongside the stage, and `start` wrote
 * the literal `agent:<kind>` into it. A test asserting "they agree after a claim"
 * would have passed in the exact window where they did not, and no test can cover
 * every future writer. Deleting the second field covers all of them.
 */

import { describe, expect, it } from 'vitest'
import { IssueAggregate } from '../aggregates/issue'
import { SessionAggregate } from '../aggregates/session'
import { IssueWire } from '../entities/issue'
import { UserAccount } from '../identity/user'
import { IssueTriage } from './issue'
import { ASSIGNEE_IS_THE_OWNER, assigneeOf, Ownership, OwnerAsAssigneeField } from './ownership'

/** Every key spelling that has ever meant "the accountable person" on an issue. */
const OWNER_SHAPED_KEYS = ['assignee', 'owner', 'ownerUserId', 'assignedTo', 'assigneeId'] as const

describe('the canonical owner is the only accountable field', () => {
  it('leaves exactly ONE owner-shaped key on the issue aggregate, and it is `owner`', () => {
    const keys = Object.keys(IssueAggregate.shape)
    const ownerShaped = OWNER_SHAPED_KEYS.filter((k) => keys.includes(k))
    // Written as the whole list rather than `toHaveLength(1)`: a failure then
    // NAMES the duplicate that came back, which is the thing a reader needs.
    expect(ownerShaped).toEqual(['owner'])
  })

  it('is gone from the triage group it used to live on', () => {
    // The specific site. `IssueTriage` held `assignee: UserIdField.optional()`
    // beside `priority` and `type` — filed as routing, which is exactly how a
    // second owner field passes review: it does not look like ownership.
    expect(Object.keys(IssueTriage.shape)).not.toContain('assignee')
  })

  it('projects the owner under the name the product uses', () => {
    const owner = Ownership.parse({ owner: 'mem_abc', visibility: 'personal' })
    expect(assigneeOf(owner)).toBe(owner.owner)
    expect(ASSIGNEE_IS_THE_OWNER).toContain('no second owner field')
  })
})

describe('the wire key survived; the second column did not', () => {
  it('keeps `assignee` on IssueWire and adds no `owner` beside it', () => {
    // Clients were never the problem, so nothing about them changed: the key they
    // read is still there. Shipping BOTH keys would have put the fork back on the
    // wire the week after it left the database.
    const keys = Object.keys(IssueWire.shape)
    expect(keys).toContain('assignee')
    expect(OWNER_SHAPED_KEYS.filter((k) => keys.includes(k))).toEqual(['assignee'])
  })

  it('makes the wire key the same schema instance as the owner', () => {
    // `toBe`, not `toEqual`, and both halves of the wrapper.
    //
    // `UserIdField` is LENGTH-ONLY, so a fresh `z.string().min(1).brand<'UserId'>()`
    // in either position parses every id-shaped string identically and is
    // byte-identical on the wire. Reference identity is the only instrument that
    // can tell "the owner, renamed" from "a second user id that happens to agree".
    expect(IssueWire.shape.assignee).toBe(OwnerAsAssigneeField)
    expect(OwnerAsAssigneeField.unwrap()).toBe(Ownership.shape.owner)
  })

  it('still parses a payload that predates the projection', () => {
    // The one reason the wire key is optional while R1's owner is required.
    // Absent means "this payload is older than the projection", never
    // "unassigned" — the column behind it is NOT NULL, so there is no such state.
    expect(OwnerAsAssigneeField.safeParse(undefined).success).toBe(true)
    expect(Ownership.shape.owner.safeParse(undefined).success).toBe(false)
  })
})

describe('creator attribution stays put while accountability moves', () => {
  it('keeps `createdBy` on the aggregate beside the mutable owner', () => {
    // A2 makes exactly one of the two mutable. `createdBy` is a fact about what
    // happened and never moves; `owner` is a fact about what is true now and any
    // active member may move it (D2). Losing the first to reassignment would make
    // the tracker unable to say who filed anything.
    expect(Object.keys(IssueAggregate.shape)).toContain('createdBy')
    expect(Object.keys(IssueAggregate.shape)).toContain('owner')
  })

  it('gives a session its OWN owner, not a view of its task’s', () => {
    // "Private runs retain their initiating human after task reassignment" (D2,
    // D7, D13) is true because the session aggregate carries its own `owner`
    // field — there is no derivation from `refIssueId` that a reassignment could
    // travel along. Asserted as the presence of the independent field, because
    // that is the form the guarantee actually takes.
    expect(Object.keys(SessionAggregate.shape)).toContain('owner')
    expect(SessionAggregate.shape.owner).toBe(Ownership.shape.owner)
  })

  it('gives an account the same owner shape as everything else', () => {
    // The user aggregate composes `Ownership` too (owner = self). One answer
    // shape across every owned class is what keeps the scoped feed from needing a
    // special case for the class that describes people.
    expect(UserAccount.shape.owner).toBe(Ownership.shape.owner)
  })
})
