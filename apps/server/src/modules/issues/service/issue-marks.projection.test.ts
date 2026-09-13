/**
 * WHOSE MARKS THE BROADCAST CARRIES, AND WHOSE THE SIDECAR CARRIES (PDM-408).
 *
 * PDM-402 fixed the WRITE: a mark lands on the row of the person who made it.
 * This file is the READ. `pinned`, `tuckedAt` and `readAt` were still resolved
 * for one named viewer — `broadcastViewer()`, the earliest admin — and baked
 * into the `IssueWire` every client receives, so every member was shown that
 * person's pins, folds and unread dots.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS THIS FILE HAS TO PROVE, AND WHY THE SECOND IS THE HARD ONE
 * ---------------------------------------------------------------------------
 *
 * 1. The sidecar carries the RIGHT person's marks. Both members get different
 *    non-default values at the same path and each row is asserted to hold its
 *    own — the same rule PDM-402's file follows, one layer out.
 *
 * 2. The broadcast carries NOBODY'S. This is the one that needs care, because
 *    the coordinator's ruling keeps the three keys on the wire at NEUTRAL
 *    values, and **a neutral value is indistinguishable from "genuinely
 *    unmarked"**. On a single-admin instance — the configuration nearly every
 *    test runs in — "the admin's marks" and "neutral" are the same bytes, so a
 *    wire still reading `broadcastViewer()` would pass any assertion that only
 *    looked at an untouched issue.
 *
 *    Every broadcast assertion here therefore runs AFTER the earliest admin has
 *    marked the issue with non-default values. If the wire were still reading
 *    her overlay it would carry `pinned: true`; neutral is then a claim that can
 *    fail, rather than a coincidence of the fixture.
 */

import {
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type IssueMarksWire,
  issueMarksRowId,
  NEUTRAL_ISSUE_MARKS,
  type UserId,
} from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../../store'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { type IssueDeps, IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'

const NOW = '2026-06-30T00:00:00.000Z'
const BEN = asUserId('mem_0BBBBBBBBBBBBBBBBBBBBBBBBBB')

let store: SessionStore
/** The admin the migration chain minted — the person the defect resolved to. */
let ada: UserId
let svc: IssueService
/** Every change row the service published, in order. */
let published: MetadataChange[]

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
    ...issueTestPlumbing((change) => published.push(change)),
    now: () => NOW,
  }
  return await IssueService.create(deps)
}

/** The marks rows published for one person, newest last. */
const marksRowsFor = (user: UserId, issueId: string): IssueMarksWire[] =>
  published
    .filter((c) => c.entity === 'issueMarks' && c.id === issueMarksRowId(user, issueId))
    .map((c) => (c as { value: IssueMarksWire }).value)

/** The STORED row for one person, straight out of the table — the durable half,
 *  as distinct from what was published. */
const storedMarksFor = async (user: UserId, issueId: string) =>
  await store.issues.getIssueUserState(user, issueId as never)

const latestMarksFor = (user: UserId, issueId: string): IssueMarksWire | undefined =>
  marksRowsFor(user, issueId).at(-1)

beforeEach(async () => {
  published = []
  store = await openTestStore(':memory:')
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
  // Ada must really be the earliest admin, or the broadcast assertions below are
  // vacuous: they work by giving HER marks and requiring the wire not to carry
  // them, which proves nothing if the wire never resolved her in the first place.
  expect(firstAdminMemberId()).toBe(ada)
  svc = await build()
})

describe('the broadcast payload', () => {
  it('carries NOBODY’s marks, even when the earliest admin has marked the issue', async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    // Ada — who IS `broadcastViewer()` — pins it, folds it and reads it. Before
    // PDM-408 every one of these landed on the wire for every client.
    await svc.close(w.id)
    await svc.update(w.id, { pinned: true }, { viewer: ada })
    await svc.setIssueTucked(w.id, true, ada)
    await svc.markIssueRead(w.id, ada)

    const wire = await svc.get(w.id)

    expect(wire).toBeDefined()
    expect(wire?.pinned).toBe(NEUTRAL_ISSUE_MARKS.pinned)
    expect(wire?.tuckedAt ?? null).toBe(NEUTRAL_ISSUE_MARKS.tuckedAt)
    expect(wire?.readAt ?? null).toBe(NEUTRAL_ISSUE_MARKS.readAt)
  })

  it('does not carry a SECOND member’s marks either', async () => {
    // The other direction. A wire that had been switched from "the admin's" to
    // "the last writer's" would pass the case above and fail here.
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(w.id, { pinned: true }, { viewer: BEN })
    await svc.markIssueRead(w.id, BEN)

    const wire = await svc.get(w.id)

    expect(wire?.pinned).toBe(false)
    expect(wire?.readAt ?? null).toBeNull()
  })
})

describe('the per-user sidecar', () => {
  it('publishes the MARKING member’s own row, and not the other’s', async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.markIssueRead(w.id, BEN)

    expect(latestMarksFor(BEN, w.id)).toMatchObject({
      userId: BEN,
      issueId: w.id,
      readAt: NOW,
      pinned: false,
    })
    // Ada never marked it, so no row of hers was ever published. The negative
    // half: a sidecar that published one row per issue rather than per person
    // would show up here.
    expect(marksRowsFor(ada, w.id)).toEqual([])
  })

  it('gives BOTH people different values at the same path, each on their own row', async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.close(w.id)

    await svc.update(w.id, { pinned: true }, { viewer: ada })
    await svc.setIssueTucked(w.id, true, BEN)

    expect(latestMarksFor(ada, w.id)).toMatchObject({ pinned: true, tuckedAt: null })
    expect(latestMarksFor(BEN, w.id)).toMatchObject({ pinned: false, tuckedAt: NOW })
  })

  it('publishes one row PER HOLDER when a reopen retires every fold', async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.close(w.id)
    await svc.setIssueTucked(w.id, true, ada)
    await svc.setIssueTucked(w.id, true, BEN)
    published = []

    await svc.update(w.id, { stage: 'in_progress' })

    // Both people's folds were cleared, so both people's rows must go out. One
    // broadcast row could not say whose fold it meant.
    expect(latestMarksFor(ada, w.id)?.tuckedAt ?? null).toBeNull()
    expect(latestMarksFor(BEN, w.id)?.tuckedAt ?? null).toBeNull()
  })

  it('keys the row by the (user, issue) PAIR, so two people never collide', async () => {
    // The row id is what `feed-visibility.ts` parses to decide delivery, so a
    // collision here would be a row delivered to the wrong person — the very
    // defect, one layer down.
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.markIssueRead(w.id, ada)
    await svc.markIssueRead(w.id, BEN)

    const ids = published.filter((c) => c.entity === 'issueMarks').map((c) => c.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain(issueMarksRowId(ada, w.id))
    expect(ids).toContain(issueMarksRowId(BEN, w.id))
  })
})

describe('purging an issue retracts its marks', () => {
  /**
   * THE TOMBSTONE PATH (PDM-408). A marks row is addressed to ONE person, so its
   * retraction has to be too: there is no row a single broadcast remove could
   * name that every holder is subscribed to.
   *
   * Two distinct failures were here, and they are different:
   *
   *  1. `issue_user_state` has NO foreign key to `issues` — only a composite
   *     primary key — so `deleteIssue` never cascaded to it. `purgeIssueUserState`
   *     existed for exactly this and had NO PRODUCTION CALLER AT ALL, so every
   *     purge left those rows in the database for good.
   *  2. Nothing published a removal, so a cached client kept rendering its
   *     owner's pin and read mark for an issue that no longer exists — the
   *     issue's own `remove` does not name the marks rows, and nothing else
   *     would ever correct them.
   *
   * This issue CREATED the row that can go stale, so retracting it belongs here.
   */
  /** `purgeEmptyDraft` is the ONLY production purge path, and it refuses
   *  anything that is not an empty draft — so the fixture has to be one. */
  const emptyDraft = async () =>
    await svc.create({
      repoPath: '/r',
      title: 'X',
      startNow: false,
      origin: 'agent',
      audience: 'agent',
      draft: true,
    })

  it('publishes a remove for EVERY holder, addressed to each of them', async () => {
    const w = await emptyDraft()
    await svc.markIssueRead(w.id, ada)
    await svc.markIssueRead(w.id, BEN)
    published = []

    await svc.purgeEmptyDraft(w.id)

    const removed = published
      .filter((c) => c.entity === 'issueMarks' && c.op === 'remove')
      .map((c) => c.id)
    // One per person. A single broadcast removal could not say whose row it
    // meant, which is the whole reason the rows are keyed per user.
    expect(removed.sort()).toEqual([issueMarksRowId(ada, w.id), issueMarksRowId(BEN, w.id)].sort())
  })

  it('drops the stored rows too, which nothing used to do', async () => {
    const w = await emptyDraft()
    await svc.markIssueRead(w.id, ada)
    await svc.markIssueRead(w.id, BEN)
    expect(await storedMarksFor(BEN, w.id)).toBeDefined()

    await svc.purgeEmptyDraft(w.id)

    // No foreign key cascades these; before PDM-408 they outlived every purge.
    expect(await storedMarksFor(ada, w.id)).toBeUndefined()
    expect(await storedMarksFor(BEN, w.id)).toBeUndefined()
  })

  it('retracts nothing for an issue nobody marked — a remove per HOLDER, not per issue', async () => {
    // The control. Without it, "publishes removes" is satisfied by a purge that
    // emits a tombstone for every member on the instance whether or not they
    // held a row, which would tell a stranger the issue had existed.
    const w = await emptyDraft()
    published = []

    await svc.purgeEmptyDraft(w.id)

    expect(published.filter((c) => c.entity === 'issueMarks')).toEqual([])
  })
})
