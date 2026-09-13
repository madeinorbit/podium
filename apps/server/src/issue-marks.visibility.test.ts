/**
 * WHO RECEIVES A MARKS ROW — the delivery half of PDM-408, against the REAL
 * `makeFeedVisibility` rather than a re-implementation of it.
 *
 * The marks themselves are proved elsewhere (`issue-marks.projection.test.ts`
 * for the broadcast and the sidecar values, `issue-marks-join.test.ts` for the
 * client join). This file asks the one question those cannot: when a row exists,
 * WHO is in its audience — and it asks the real policy object the feed is built
 * over, because a test that restated the arm would agree with itself.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 *
 * PDM-139's words: *user-match is necessary for the sidecar and must never
 * become issue-owner matching*. That is not a hypothetical — it is the arm B4
 * wrote for `issueExecution`, sitting a few lines away in the same `mayRead`
 * switch, and it resolves the ISSUE's owner. Routing marks through it would hand
 * one person's pins, folds and unread state to whoever owns the task, which for
 * a shared issue is somebody else. `classOf` returning `personal` instead of
 * `per-user-state` does the same thing by a different door: it would make marks
 * GRANTABLE, and "share my pins" is not a verb.
 *
 * So the assertions below are about the policy's own answers, and the
 * discriminating fixture is an issue owned by SOMEBODY ELSE: every case names a
 * marks row belonging to `reader` on an issue owned by `owner`, so a rule that
 * had quietly become owner-matching answers `owner` where it must answer
 * `reader`.
 */

import { asIssueId, asUserId, issueMarksRowId } from '@podium/model'
import type { EntityRef } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore, IssueRow, SessionRow } from './hot-path-ports'
import { WorldIndex } from './modules/world-index'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

const owner = asUserId('owner')
const reader = asUserId('reader')
const stranger = asUserId('stranger')
const SHARED = asIssueId('shared')

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const world = await WorldIndex.load(store)
  const issue = { id: SHARED, ownerUserId: owner } as IssueRow
  const session = { id: 'shared', ownerUserId: owner } as unknown as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
      getIssue: async () => issue,
      getIssues: async () => new Map([[issue.id, issue]]),
    },
    sessions: {
      getSessions: async () => new Map([['shared', session]]),
      findSessionsByResumeValues: async () => new Map(),
      findSessionsByIssueIds: async () => [],
    },
    shipping: { issueIdsForOrders: async () => new Map() },
    automations: { ownerOf: async () => undefined, runOwnerOf: async () => undefined },
    sync: store.sync,
  }
  const policy = makeFeedVisibility({
    store: rows,
    worldIndex: world.reader,
    audienceResourceIds: (kind) => store.grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  return { store, policy }
}

/** `reader`'s marks on an issue owned by SOMEBODY ELSE — the discriminating row. */
const readersMarksOnOwnersIssue: EntityRef = {
  entity: 'issueMarks',
  entityId: issueMarksRowId(reader, SHARED),
}

describe('a marks row is addressed to its own user', () => {
  it('is classified per-user-state, so it can never be granted away', async () => {
    const { policy } = await fixture()

    expect(policy.state.classOf('issueMarks')).toBe('per-user-state')
    // The negative half, and the one that matters: `personal` is what every
    // issue-shaped kind beside it returns, and it is the class that consults
    // grant edges. A pin that fell through to it would become shareable.
    expect(policy.state.classOf('issueMarks')).not.toBe('personal')
  })

  it('keys to the ROW’s user, not to the issue’s owner', async () => {
    const { policy } = await fixture()

    // `owner` owns the issue; `reader` owns the marks. A rule that had become
    // owner-matching — B4's `issueExecution` arm, a few lines away in the same
    // file — answers `owner` here.
    expect(policy.state.keyedUserOf(readersMarksOnOwnersIssue)).toBe(reader)
  })

  it('answers the same for a row on an issue nobody in the fixture owns', async () => {
    const { policy } = await fixture()

    // Deleted, purged, or simply never loaded: the delivery decision must not
    // depend on the issue being resolvable at all, or a marks row would become
    // undeliverable — or worse, fall through to a default audience — the moment
    // its issue went away.
    const onAGhost: EntityRef = {
      entity: 'issueMarks',
      entityId: issueMarksRowId(reader, asIssueId('iss_long_gone')),
    }

    expect(policy.state.keyedUserOf(onAGhost)).toBe(reader)
  })

  it('refuses a malformed row id rather than guessing a recipient', async () => {
    const { policy } = await fixture()

    // `null` means "not keyed", which the kernel treats as undeliverable. The
    // alternative — a best-effort split — is a row handed to whoever the
    // garbage happened to name.
    expect(policy.state.keyedUserOf({ entity: 'issueMarks', entityId: 'no-separator' })).toBeNull()
  })

  it('is NOT delivered through mayRead, which stays closed for this kind', async () => {
    const { policy } = await fixture()

    // `per-user-state` is decided by `keyedUserOf`; `mayRead` returns false for
    // it by design. Asserted rather than assumed, because if this ever started
    // answering true the row would be delivered by BOTH doors and the keyed one
    // would stop being the only gate — for the owner, the stranger and the row's
    // own user alike.
    for (const who of [owner, reader, stranger]) {
      expect(await policy.state.mayRead(who, readersMarksOnOwnersIssue)).toBe(false)
    }
  })

  it('gives two different non-admin members their own rows, not each other’s', async () => {
    // TWO NON-DEFAULT USERS (PDM-139). Every other fixture in this port pairs a
    // member against the earliest admin, which cannot tell "per-user" from
    // "falls back to the admin". Neither of these two is that person.
    const { policy } = await fixture()
    const ben = asUserId('mem_ben')
    const cleo = asUserId('mem_cleo')

    expect(
      policy.state.keyedUserOf({ entity: 'issueMarks', entityId: issueMarksRowId(ben, SHARED) }),
    ).toBe(ben)
    expect(
      policy.state.keyedUserOf({ entity: 'issueMarks', entityId: issueMarksRowId(cleo, SHARED) }),
    ).toBe(cleo)
  })
})
