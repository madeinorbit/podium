/**
 * WHOSE `(userId, issueId)` ROW A MARK LANDS ON (PDM-402, the write half).
 *
 * `read_at`, `tucked_at` and `pinned_at` have been keyed `(user_id, issue_id)`
 * since POD-1076, but every writer resolved the key through
 * `IssueService.broadcastViewer()` — `firstAdminMemberId(store)` — so whichever
 * member pressed the control, the marker was stamped on the EARLIEST ADMIN's
 * row. `markIssueUnread`'s own doc said "marking MY copy unread never touches
 * yours"; as shipped it was false in both directions at once, touching the
 * admin's row and never the caller's.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ASSERTIONS CAN SAY NO
 * ---------------------------------------------------------------------------
 *
 * Every case gives BOTH people a DIFFERENT non-default value at the SAME path
 * and asserts EACH one reads back their own. Checking Ben alone would pass
 * against a writer that had simply stopped writing anything; checking Ada alone
 * would pass against the defect itself. The negative half — "and the other
 * person's row is untouched" — is what separates a per-viewer write from a
 * write that lands on both.
 *
 * Ada is not an invented id. She is the admin the migration chain mints, read
 * back out of the store, so she genuinely IS `firstAdminMemberId()` and the
 * pre-fix code genuinely did resolve to her. Seeding a "first admin" of my own
 * would have tested a fixture instead of the defect.
 *
 * Assertions are made against `store.issues.getIssueUserState(user, issue)` —
 * the stored row, per user — rather than against the broadcast wire. The wire
 * still carries ONE viewer's overlay for everybody; that is the READ half of
 * PDM-402 and it is deliberately not what this file measures. A test that
 * asserted through the wire would go green only when both halves landed and
 * would tell you nothing about which one was missing.
 */

import {
  asIssueId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type MutationId,
  type UserId,
} from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { systemPrincipal } from '../../../command-principal'
import type { Capability } from '../../../issue-authz'
import type { SessionStore } from '../../../store'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { IssueCommandDispatcher } from '../dispatcher'
import { type IssueDeps, IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'

const NOW = '2026-06-30T00:00:00.000Z'
/** A second member, created after the migration's admin so she stays earliest. */
const BEN = asUserId('mem_0BBBBBBBBBBBBBBBBBBBBBBBBBB')

let store: SessionStore
/** The admin the migration chain minted — the person the defect resolved to. */
let ada: UserId
let svc: IssueService

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

beforeEach(async () => {
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
  // Ada must really be the earliest admin, or every assertion below is vacuous:
  // the defect resolves to `firstAdminMemberId()`, and if that is not Ada then a
  // green "Ben got his own" proves nothing about the defect.
  expect((await store.users.earliestAdmin())?.id).toBe(ada)
  expect(firstAdminMemberId()).toBe(ada)
  svc = await build()
})

const marksOf = async (user: UserId, issueId: string) =>
  await store.issues.getIssueUserState(user, issueId as never)

describe('marking an issue read', () => {
  it("stamps the MARKING member's row, not the earliest admin's", async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.markIssueRead(w.id, BEN)

    expect((await marksOf(BEN, w.id))?.readAt).toBe(NOW)
    // The negative half: Ada was the only person this used to write, so her row
    // staying absent is the whole claim.
    expect(await marksOf(ada, w.id)).toBeUndefined()
  })

  it('still stamps Ada when Ada is the one marking', async () => {
    // …so the test above is not green merely because the write stopped landing.
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.markIssueRead(w.id, ada)

    expect((await marksOf(ada, w.id))?.readAt).toBe(NOW)
    expect(await marksOf(BEN, w.id)).toBeUndefined()
  })

  it('leaves one member unread while the other has read it', async () => {
    // BOTH people, DIFFERENT non-default values at the SAME path, in one store.
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.markIssueRead(w.id, ada)
    await svc.markIssueRead(w.id, BEN)
    await svc.markIssueUnread(w.id, BEN)

    expect((await marksOf(ada, w.id))?.readAt).toBe(NOW)
    // Ben's row is deleted rather than kept once every marker is null, so
    // "absent" is the only spelling of unread — see `setIssueUserState`.
    expect(await marksOf(BEN, w.id)).toBeUndefined()
  })
})

describe('tucking a finished issue away', () => {
  const closed = async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.close(w.id)
    return w
  }

  it("folds the TUCKING member's copy, and only theirs", async () => {
    const w = await closed()

    await svc.setIssueTucked(w.id, true, BEN)

    expect((await marksOf(BEN, w.id))?.tuckedAt).toBe(NOW)
    expect((await marksOf(ada, w.id))?.tuckedAt ?? null).toBeNull()
  })

  it('un-tucking one member does not bring the issue back for the other', async () => {
    const w = await closed()

    await svc.setIssueTucked(w.id, true, ada)
    await svc.setIssueTucked(w.id, true, BEN)
    await svc.setIssueTucked(w.id, false, BEN)

    expect((await marksOf(ada, w.id))?.tuckedAt).toBe(NOW)
    expect((await marksOf(BEN, w.id))?.tuckedAt ?? null).toBeNull()
  })

  it('reopening retires EVERY member’s dismissal, not just the admin’s', async () => {
    // The one write here that is deliberately NOT per-viewer. A reopened issue
    // must not stay folded away for anybody, or the next time it finishes it
    // folds itself out of sight of a member who never dismissed this round.
    const w = await closed()
    await svc.setIssueTucked(w.id, true, ada)
    await svc.setIssueTucked(w.id, true, BEN)

    await svc.update(w.id, { stage: 'in_progress' })

    expect((await marksOf(ada, w.id))?.tuckedAt ?? null).toBeNull()
    expect((await marksOf(BEN, w.id))?.tuckedAt ?? null).toBeNull()
  })
})

describe('pinning an issue', () => {
  it("pins on the PINNING member's row, not the earliest admin's", async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.update(w.id, { pinned: true }, { viewer: BEN })

    expect((await marksOf(BEN, w.id))?.pinnedAt).toBe(NOW)
    expect((await marksOf(ada, w.id))?.pinnedAt ?? null).toBeNull()
  })

  it('one member un-pinning leaves the other member pinned', async () => {
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await svc.update(w.id, { pinned: true }, { viewer: ada })
    await svc.update(w.id, { pinned: true }, { viewer: BEN })
    await svc.update(w.id, { pinned: false }, { viewer: BEN })

    expect((await marksOf(ada, w.id))?.pinnedAt).toBe(NOW)
    expect((await marksOf(BEN, w.id))?.pinnedAt ?? null).toBeNull()
  })

  it('refuses a pin that cannot name the member pinning', async () => {
    // FAIL CLOSED. Substituting a viewer is exactly how the marker came to be
    // the admin's for everybody; an update that carries `pinned` without one is
    // refused rather than defaulted.
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await expect(svc.update(w.id, { pinned: true })).rejects.toThrow(/pin/i)
    expect(await marksOf(ada, w.id)).toBeUndefined()
    expect(await marksOf(BEN, w.id)).toBeUndefined()
  })
})

/**
 * THE DOOR, not just the room.
 *
 * Everything above calls the service directly, which proves the WRITE takes a
 * member and honours it. It cannot prove the command layer hands it the right
 * one — and "the service is per-viewer now" is worth nothing if the three
 * registry handlers still resolve the earliest admin on their way in. These
 * dispatch through `IssueCommandDispatcher`, which mints the principal from the
 * caller's capability exactly as the transports do.
 */
describe('through the command layer', () => {
  const dispatcherFor = (svc: IssueService) =>
    new IssueCommandDispatcher({
      fileGate: () => ({
        readRootAsset: async () => {
          throw new Error('artifact source reads are not exercised in this file')
        },
        listRoot: async () => {
          throw new Error('artifact source reads are not exercised in this file')
        },
      }),
      issues: svc,
      shipping: {} as never,
      arbitration: { run: (_input, operation) => operation() },
      attachSession: () => {
        throw new Error('not used')
      },
      deleteIssue: () => undefined,
      restoreIssue: () => undefined,
      mutations: {
        apply: async <T>(
          _id: MutationId | undefined,
          _proc: string,
          body: () => T | Promise<T>,
        ): Promise<{ outcome: 'applied'; value: Awaited<T> }> => ({
          outcome: 'applied',
          value: await body(),
        }),
        once: async <T>(
          _id: MutationId | undefined,
          _proc: string,
          body: () => T | Promise<T>,
        ): Promise<Awaited<T>> => await body(),
      },
      sessionById: async () => undefined,
      listSessionsForIssue: async () => [],
      repoPaths: () => ['/r'],
      inferRepoFromPath: () => undefined,
    })

  /** A person at the CLI or the web app: unconstrained scope, acting as themselves. */
  const operator = (human: UserId): Capability => ({
    role: 'admin',
    scope: { kind: 'all' },
    actorUser: human,
    onBehalfOf: human,
  })

  /** AN ORDINARY MEMBER, not an admin — `userCommandPrincipal(user, 'member')`'s
   *  own shape: `worker` role, scope narrowed to what they own. The cases above
   *  all ran as `admin`/`all`, which is the ONE capability shape under which a
   *  resolver that had quietly kept reading the earliest admin could still look
   *  right on an instance where the admin is the only person — so the member arm
   *  is where the claim is actually load-bearing. */
  const member = (human: UserId): Capability => ({
    role: 'worker',
    scope: { kind: 'owned', userId: human },
    actorUser: human,
    onBehalfOf: human,
  })

  /** An agent session working an issue, delegated by one human. */
  const agentOn = (human: UserId, issueId: string, sessionId: string): Capability => ({
    role: 'worker',
    scope: { kind: 'subtree', rootId: asIssueId(issueId) },
    actorSessionId: asSessionId(sessionId),
    onBehalfOf: human,
  })

  it('issues.markRead stamps the CALLER, not the earliest admin', async () => {
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await dispatcher.dispatch({ capability: operator(BEN) }, 'issues', 'markRead', { id: w.id })

    expect((await marksOf(BEN, w.id))?.readAt).toBe(NOW)
    expect(await marksOf(ada, w.id)).toBeUndefined()
  })

  it('issues.setTucked folds the CALLER’s copy', async () => {
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.close(w.id)

    await dispatcher.dispatch({ capability: operator(BEN) }, 'issues', 'setTucked', {
      id: w.id,
      tucked: true,
    })

    expect((await marksOf(BEN, w.id))?.tuckedAt).toBe(NOW)
    expect((await marksOf(ada, w.id))?.tuckedAt ?? null).toBeNull()
  })

  it('issues.update with a pin stamps the CALLER', async () => {
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await dispatcher.dispatch({ capability: operator(BEN) }, 'issues', 'update', {
      id: w.id,
      patch: { pinned: true },
    })

    expect((await marksOf(BEN, w.id))?.pinnedAt).toBe(NOW)
    expect((await marksOf(ada, w.id))?.pinnedAt ?? null).toBeNull()
  })

  it('and Ada still gets her own through the same door', async () => {
    // The control. Without it every assertion above is satisfied by a handler
    // that had simply stopped writing.
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await dispatcher.dispatch({ capability: operator(ada) }, 'issues', 'markRead', { id: w.id })

    expect((await marksOf(ada, w.id))?.readAt).toBe(NOW)
    expect(await marksOf(BEN, w.id)).toBeUndefined()
  })

  it('issues.markUnread clears the CALLER’s marker and leaves the other member’s', async () => {
    // THE FOURTH REGISTRY ARM. markRead, setTucked and update/pin are covered
    // above; markUnread is a separate `def` with its own `markerViewer()` call,
    // so a handler that forgot it would sit behind three green doors.
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.markIssueRead(w.id, ada)
    await svc.markIssueRead(w.id, BEN)

    await dispatcher.dispatch({ capability: operator(BEN) }, 'issues', 'markUnread', { id: w.id })

    // Ben's row is deleted once every marker is null — "absent" is the only
    // spelling of unread — and Ada's read stands untouched beside it.
    expect(await marksOf(BEN, w.id)).toBeUndefined()
    expect((await marksOf(ada, w.id))?.readAt).toBe(NOW)
  })

  it('a MEMBER, not an admin, marks their own row', async () => {
    // The capability shape every other case here skipped. On a single-admin
    // instance `admin`/`all` and "the earliest admin" are the same person, so a
    // resolver still reading `firstAdminMemberId()` looks correct through that
    // door; through this one it cannot.
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })
    // Owned by Ben, because a `worker`/`owned` capability may only reach rows
    // that are his — otherwise this would measure the read gate, not the write.
    await svc.update(w.id, { ownerUserId: BEN })

    await dispatcher.dispatch({ capability: member(BEN) }, 'issues', 'markRead', { id: w.id })

    expect((await marksOf(BEN, w.id))?.readAt).toBe(NOW)
    expect(await marksOf(ada, w.id)).toBeUndefined()
  })

  it('an AGENT stamps its delegating human, not the agent and not the admin', async () => {
    // ADR 3 D17: the row belongs to the human the agent acts FOR, resolved from
    // the delegation record rather than from anything on the input. Ben's agent
    // reads Ada's issue; the marker is BEN's.
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await dispatcher.dispatch({ capability: agentOn(BEN, w.id, 's_ben') }, 'issues', 'markRead', {
      id: w.id,
    })

    expect((await marksOf(BEN, w.id))?.readAt).toBe(NOW)
    expect(await marksOf(ada, w.id)).toBeUndefined()
  })

  it('REFUSES a caller with no attributable human, and writes nobody’s row', async () => {
    // The fail-closed arm, and the only one that can prove `markerViewer()`
    // refuses rather than substitutes. A system principal is representable
    // "no human" (ADR 3 Amendment 1 D21) — `onBehalfOfUser` returns null for it
    // — and it reaches the handler because its CAPABILITY is unconstrained, so
    // the guard admits it and only the marker resolver can say no.
    const dispatcher = dispatcherFor(svc)
    const w = await svc.create({ repoPath: '/r', title: 'X', startNow: false })

    await expect(
      dispatcher.dispatch(
        { capability: operator(ada), principal: systemPrincipal('test-job') },
        'issues',
        'markRead',
        { id: w.id },
      ),
    ).rejects.toThrow('per-user issue marks require a human principal')

    // Not "refused and wrote it anyway", and not "refused by writing the admin's
    // row instead", which is the failure this whole issue is about.
    expect(await marksOf(ada, w.id)).toBeUndefined()
    expect(await marksOf(BEN, w.id)).toBeUndefined()
  })
})
