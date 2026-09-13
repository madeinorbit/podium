/**
 * A SHARED ORDER MUST NOT BE MINTED FROM ONE PERSON'S PINS (PDM-429).
 *
 * `sort_key` is a column on the shared `issues` table. `pinned` is a
 * `(user_id, issue_id)` row (POD-1076). Until this issue, `mintSortKey`
 * measured the scope's top key over the rows MINUS the pinned ones, and
 * "pinned" there meant `issueOverlay(...).pinned` — one named viewer's answer.
 * So the anchor a new issue was keyed against depended on WHO was asking, and
 * both askers wrote into the same key space. PDM-429 deleted the narrower scope
 * rather than threading a viewer into it; these are the assertions that say so.
 *
 * ---------------------------------------------------------------------------
 * WHICH HALF OF THIS FILE CAN CURRENTLY FAIL, STATED SO A GREEN IS NOT READ AS
 * MORE THAN IT IS
 * ---------------------------------------------------------------------------
 *
 * ADA'S HALF DISCRIMINATES TODAY. She is the migration's earliest admin, so she
 * genuinely is `firstAdminMemberId()` and therefore `broadcastViewer()` — the
 * one viewer whose markers the service can presently see. Restore the pin
 * predicate to the mint scope and `a pin held by the gating viewer does not move
 * the mint point` goes red, because the pinned top row leaves the scope and the
 * next key anchors on the row below it instead.
 *
 * BEN'S HALF CANNOT CURRENTLY FAIL, AND THAT IS NOT A DEFECT IN IT. The service
 * hydrates `viewerState` once, for the broadcast viewer alone, so a second
 * member's pin is invisible to the mint whatever the mint's scope is — the
 * assertion would pass against the defect as well as against the repair. It is
 * written as a FORWARD GUARD for the state PDM-402 is bringing about, where the
 * overlay becomes per-principal and a re-introduced per-viewer scope would make
 * Ben's pin move a shared key. Do not count it as evidence for the repair; the
 * evidence is Ada's half and the deliberate break recorded in the receipt.
 *
 * Ada is read out of the store rather than invented, for the reason
 * `issue-marks.viewer.test.ts` gives on PDM-402's branch: seeding a "first
 * admin" of one's own tests the fixture instead of the subject.
 */

import { asSessionId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../../store'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { type IssueDeps, IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'

const NOW = '2026-06-30T00:00:00.000Z'
/** A second member, created after the migration's admin so Ada stays earliest. */
const BEN = asUserId('mem_0BBBBBBBBBBBBBBBBBBBBBBBBBB')

let store: SessionStore
/** The admin the migration chain mints — the viewer the mint used to consult. */
let ada: UserId
let svc: IssueService
/** Every store this file opens, so each is closed once (see the `afterEach`).
 *  A test that replaces `store` must push the new handle here BEFORE the
 *  assignment, or the old one is unreachable and never closed. */
const openedStores: SessionStore[] = []

/** Open a store, register it for cleanup, and make it the current one. */
async function openStore(): Promise<SessionStore> {
  const opened = await openTestStore(':memory:')
  openedStores.push(opened)
  store = opened
  return opened
}

async function build(): Promise<IssueService> {
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({
      sessionId: asSessionId('s1'),
      machine: 'machine-under-test',
    })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    now: () => NOW,
  }
  return await IssueService.create(deps)
}

afterEach(async () => {
  // Splice, so a close that throws cannot leave the list holding handles a later
  // test would try to close again.
  for (const opened of openedStores.splice(0)) await opened.close()
})

beforeEach(async () => {
  await openStore()
  const earliest = await store.users.earliestAdmin()
  if (!earliest) throw new Error('fixture: the migrated store has no earliest admin')
  ada = asUserId(earliest.id)
  await store.users.create(
    {
      id: BEN,
      displayName: 'Ben',
      role: 'member',
      createdAt: '2099-01-01T00:00:00.000Z',
      disabledAt: null,
    },
    'scrypt:hash',
  )
  // Ada must really be the gating viewer, or her half is vacuous too: the
  // behaviour under test resolved through `firstAdminMemberId()`, and if that is
  // not Ada then a green says nothing about the scope the mint used to take.
  expect((await store.users.earliestAdmin())?.id).toBe(ada)
  expect(firstAdminMemberId()).toBe(ada)
  svc = await build()
})

/** Three top-level rows in one scope, returned newest-first — which is also
 *  smallest-key-first, since every create mints above the scope minimum. */
async function threeRows() {
  const oldest = await svc.create({ repoPath: '/r', title: 'oldest', startNow: false })
  const middle = await svc.create({ repoPath: '/r', title: 'middle', startNow: false })
  const top = await svc.create({ repoPath: '/r', title: 'top', startNow: false })
  // The precondition every assertion below rests on. If the seed did not come
  // out in this order, "minted above the top row" is not the question being
  // asked and a pass would mean nothing.
  expect((top.sortKey ?? '') < (middle.sortKey ?? '')).toBe(true)
  expect((middle.sortKey ?? '') < (oldest.sortKey ?? '')).toBe(true)
  return { oldest, middle, top }
}

const pinnedAtOf = async (user: UserId, issueId: string) =>
  (await store.issues.getIssueUserState(user, issueId as never))?.pinnedAt ?? null

describe('the mint scope does not consult per-user pins (PDM-429)', () => {
  it('a pin held by the gating viewer does not move the mint point', async () => {
    const { middle, top } = await threeRows()

    const pinned = await svc.update(top.id, { pinned: true })

    // LOAD-BEARING FOR THE BREAK, not decoration. If the pin quietly failed to
    // land, the restored predicate would have nothing to exclude, the old code
    // would anchor on `top` as well, and the deliberate break would stay green —
    // a false green that looks exactly like a passing repair.
    expect(pinned.pinned).toBe(true)
    expect(await pinnedAtOf(ada, top.id)).toBe(NOW)
    // Pin/unpin leaves the key alone (POD-1102); the pinned row is still the
    // scope minimum, which is what makes it the anchor under test.
    expect(pinned.sortKey).toBe(top.sortKey)

    const next = await svc.create({ repoPath: '/r', title: 'after the pin', startNow: false })

    // The whole claim: keyed above the PINNED row. Under the old scope the
    // pinned row was excluded, so this key anchored on `middle` and landed
    // BETWEEN the two — `top < next` rather than `next < top`.
    expect((next.sortKey ?? '') < (top.sortKey ?? '')).toBe(true)
    expect((next.sortKey ?? '') < (middle.sortKey ?? '')).toBe(true)
  })

  it('unpinning does not move it either — the scope never changed', async () => {
    // The other direction of the same property. A scope that still consulted
    // pins would mint one key while pinned and a different one after unpinning;
    // an unchanging scope mints against the same anchor both times.
    const { top } = await threeRows()

    await svc.update(top.id, { pinned: true })
    const whilePinned = await svc.create({ repoPath: '/r', title: 'while pinned', startNow: false })
    await svc.update(top.id, { pinned: false })
    expect(await pinnedAtOf(ada, top.id)).toBeNull()

    const afterUnpin = await svc.create({ repoPath: '/r', title: 'after unpin', startNow: false })

    // Both above `top`, and the later one above the earlier — one ladder, no
    // step sideways when the pin came off.
    expect((whilePinned.sortKey ?? '') < (top.sortKey ?? '')).toBe(true)
    expect((afterUnpin.sortKey ?? '') < (whilePinned.sortKey ?? '')).toBe(true)
  })

  it('a pin stored for a non-gating member does not move the mint point', async () => {
    // WHAT THIS ESTABLISHES, and the title says only that much (PDM-453). Two
    // people hold different non-default values at the SAME path
    // (`issue_user_state.pinned_at`), and the key this service mints is
    // independent of BOTH. That is independence from the stored pins the
    // service can see — not two asking principals minting the same key.
    //
    // IT IS NOT A TWO-PRINCIPAL WITNESS, because BOTH creates below are issued
    // through ONE service that resolves ONE viewer; Ben never asks for anything.
    // An earlier title here said "two members ... mint the identical key", which
    // claimed the thing the construction cannot reach. The real second-principal
    // witness needs a consumer that can create AS Ben, which does not exist at
    // this pin; when PDM-402 lands one, that witness belongs here beside this.
    //
    // Ada's pin goes through the service so the hydrated overlay sees it; Ben's
    // is written straight to the store because no service path can currently
    // reach a non-broadcast member's row. Ben's leg therefore cannot fail today
    // whatever the mint's scope is — it is a forward guard, not evidence for the
    // repair. The evidence is Ada's discriminating witness above.
    const { oldest, top } = await threeRows()

    await svc.update(top.id, { pinned: true })
    await store.issues.setIssueUserState(BEN, oldest.id as never, { pinnedAt: NOW })

    expect(await pinnedAtOf(ada, top.id)).toBe(NOW)
    expect(await pinnedAtOf(BEN, oldest.id)).toBe(NOW)
    // Neither person's pin reached the other's row, so the two really are
    // different values rather than one value read twice.
    expect(await pinnedAtOf(BEN, top.id)).toBeNull()
    expect(await pinnedAtOf(ada, oldest.id)).toBeNull()

    const withPins = await svc.create({ repoPath: '/r', title: 'with pins', startNow: false })

    // The control: the same three creates and the same fourth create, in a store
    // where nobody has pinned anything. Same key, so no stored pin moved the
    // anchor. Without this leg the assertion above is just a string comparison
    // against itself.
    //
    // `openStore` registers the new handle for cleanup BEFORE it replaces
    // `store`, so the pinned store above is still closed by the `afterEach`
    // rather than being dropped here (PDM-453).
    await openStore()
    svc = await build()
    await threeRows()
    const noPins = await svc.create({ repoPath: '/r', title: 'with pins', startNow: false })

    expect(withPins.sortKey).toBe(noPins.sortKey)
  })
})
