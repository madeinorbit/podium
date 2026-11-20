import { asIssueId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { IssueRow, SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { testStoreEngine } from './test-support/pg-test-database'
import { storeSql } from './test-support/store-sql'

/** A store whose host reports `/r`: an issue row resolves its repo only through a machine that REPORTED it (2b803efb5). */
async function openIssueStore(): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachine!.id)
  return store
}

const T1 = '2026-07-01T00:00:01.000Z'
const T2 = '2026-07-01T00:00:02.000Z'
const T3 = '2026-07-01T00:00:03.000Z'
const T_READ = '2026-07-01T00:00:04.000Z'
const T_CLAIM = '2026-07-01T00:00:05.000Z'
const T_CLAIM_2 = '2026-07-01T00:00:06.000Z'

/** An instant per fixture id (`s1`, `r7`): ids of one prefix order as their instants do. */
const stampOf = (id: string): string => `2026-07-02T00:00:${id.slice(1).padStart(2, '0')}.000Z`

/** The columns of `issues`, from each engine's catalogue. */
async function issueColumns(store: SessionStore): Promise<Set<string>> {
  const raw = storeSql(store)
  const rows = await raw.all<{ name: string }>(
    raw.engine === 'pg'
      ? sql`SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'issues'`
      : sql`SELECT name FROM pragma_table_info('issues')`,
  )
  return new Set(rows.map((r) => r.name))
}

/** The store's tables, from each engine's catalogue. */
async function tableNames(store: SessionStore): Promise<Set<string>> {
  const raw = storeSql(store)
  const rows = await raw.all<{ name: string }>(
    raw.engine === 'pg'
      ? sql`SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
      : sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
  )
  return new Set(rows.map((r) => r.name))
}

describe('issues schema migration (P1)', () => {
  it('fresh DB has all new rich-field columns', async () => {
    const cols = await issueColumns(await openTestStore(':memory:'))
    for (const c of [
      'priority',
      'type',
      'assignee',
      'parent_id',
      'acceptance',
      'due_at',
      'defer_until',
      'closed_reason',
      'superseded_by',
      'duplicate_of',
      // 'pinned' was here until POD-1076 re-keyed it onto `issue_user_state`; the
      // absence is asserted positively in the per-user describe block below, not
      // by silently shortening this list.
      'estimate_min',
      // needs-human question metadata (issue #53, migration 018)
      'human_question_options',
      'human_question_asked_by',
      'human_question_asked_at',
    ]) {
      expect(cols.has(c), `missing column ${c}`).toBe(true)
    }
    expect(cols.has('color')).toBe(false)
  })
})

describe('issues child tables (P1)', () => {
  it('creates issue_labels, issue_deps, issue_comments', async () => {
    const t = await tableNames(await openTestStore(':memory:'))
    expect(t.has('issue_labels')).toBe(true)
    expect(t.has('issue_deps')).toBe(true)
    expect(t.has('issue_comments')).toBe(true)
  })
})

function baseRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId('iss_x'),
    ownerUserId: firstAdminMemberId(),
    visibility: 'personal',
    createdByActor: firstAdminMemberId(),
    createdByOnBehalfOf: firstAdminMemberId(),
    repoPath: '/r',
    seq: 1,
    title: 'X',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    createdAt: T1,
    updatedAt: T1,
    archived: false,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    acceptance: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    ...over,
  }
}

describe('needs-human question metadata round-trip (issue #53)', () => {
  it('persists options/askedBy/askedAt; corrupt options quarantine to null', async () => {
    const store = await openIssueStore()
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({
        needsHuman: true,
        humanQuestion: 'merge?',
        humanQuestionOptions: ['Yes, merge', 'No', 'Later'],
        humanQuestionAskedBy: asSessionId('sess_1'),
        humanQuestionAskedAt: '2026-07-14T00:00:00.000Z',
      }),
    )
    const back = (await store.issues.getIssue('iss_x'))!
    expect(back.humanQuestionOptions).toEqual(['Yes, merge', 'No', 'Later'])
    expect(back.humanQuestionAskedBy).toBe('sess_1')
    expect(back.humanQuestionAskedAt).toBe('2026-07-14T00:00:00.000Z')
    // A row literal without the optional fields (legacy shape) reads back null.
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({ id: asIssueId('iss_plain'), seq: 2, needsHuman: true }),
    )
    const plain = (await store.issues.getIssue('iss_plain'))!
    expect(plain.humanQuestionOptions).toBeNull()
    expect(plain.humanQuestionAskedBy).toBeNull()
    expect(plain.humanQuestionAskedAt).toBeNull()
    // Corrupt options JSON degrades to null (free-form question) — row survives. Only
    // SQLite can hold it: the column is json on Postgres, which refuses the text.
    if (testStoreEngine() === 'sqlite') {
      await storeSql(store).run(
        sql`UPDATE issues SET human_question_options = ${'not-json'} WHERE id = ${'iss_x'}`,
      )
      expect((await store.issues.getIssue('iss_x'))!.humanQuestionOptions).toBeNull()
    }
  })
})

/** Seed bare parent issues — FKs (migration 006) require referenced rows to exist. */
async function seedIssues(store: SessionStore, ...ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({ id: asIssueId(id), seq: 100 + i }),
    )
  }
}

describe('IssueRow rich fields round-trip (P1)', () => {
  it('persists and reads back new fields', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_epic', 'iss_new', 'iss_canon')
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({
        priority: 0,
        type: 'decision',
        assignee: asUserId('agent:claude'),
        parentId: asIssueId('iss_epic'),
        acceptance: 'A',
        dueAt: '2026-07-01T00:00:00.000Z',
        deferUntil: '2026-07-05T00:00:00.000Z',
        closedReason: 'duplicate',
        supersededBy: asIssueId('iss_new'),
        duplicateOf: asIssueId('iss_canon'),
        estimateMin: 30,
      }),
    )
    const r = (await store.issues.getIssue('iss_x'))!
    expect(r.priority).toBe(0)
    expect(r.type).toBe('decision')
    expect(r.assignee).toBe('agent:claude')
    expect(r.parentId).toBe('iss_epic')
    expect(r.estimateMin).toBe(30)
    expect(r.deferUntil).toBe('2026-07-05T00:00:00.000Z')
    expect(r.closedReason).toBe('duplicate')
  })

  it('defaults are applied for a minimal legacy-style insert', async () => {
    const store = await openIssueStore()
    await store.issues.upsertIssue(fixtureWriteScope(), baseRow())
    const r = (await store.issues.getIssue('iss_x'))!
    expect(r.priority).toBe(2)
    expect(r.type).toBe('task')
  })
})

// PER-USER issue state (POD-1076). This used to assert that `read_at` was an
// additive COLUMN on `issues`; the re-key inverted it, so the flipped form asserts
// the column is gone and the marker is one person's row.
describe('per-user issue state (POD-1076)', () => {
  it('the three markers are NOT columns on the shared issue row', async () => {
    const cols = await issueColumns(await openTestStore(':memory:'))
    // The instrument can say YES about a column that IS there — without this,
    // every absence claim below would pass against a table it failed to read.
    expect(cols.has('stage')).toBe(true)
    expect(cols.has('read_at')).toBe(false)
    expect(cols.has('tucked_at')).toBe(false)
    expect(cols.has('pinned')).toBe(false)
  })

  it('persists all three markers on ONE (userId, issueId) row, per user', async () => {
    const store = await openIssueStore()
    await store.issues.upsertIssue(fixtureWriteScope(), baseRow({ id: asIssueId('iss_read') }))
    // Distinct seq — UNIQUE(repo_path, seq) is enforced since migration 004.
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({ id: asIssueId('iss_untouched'), seq: 2 }),
    )

    await store.issues.setIssueUserState(
      fixtureWriteScope(),
      firstAdminMemberId(),
      asIssueId('iss_read'),
      {
        readAt: '2026-07-07T00:00:00.000Z',
        tuckedAt: '2026-07-08T00:00:00.000Z',
      },
    )
    expect(
      await store.issues.getIssueUserState(firstAdminMemberId(), asIssueId('iss_read')),
    ).toEqual({
      readAt: '2026-07-07T00:00:00.000Z',
      tuckedAt: '2026-07-08T00:00:00.000Z',
      joinedAt: null,
      joinedVia: null,
      assignedAt: null,
      assignedBy: null,
    })
    // An issue nobody touched has NO row — absence is the single spelling.
    expect(
      await store.issues.getIssueUserState(firstAdminMemberId(), asIssueId('iss_untouched')),
    ).toBeUndefined()

    // The PARTIAL patch: writing readAt must not disturb tuckedAt. This is the
    // whole reason the method takes a patch rather than a row — a whole-row
    // upsert makes "marking it read un-tucked it" a one-line mistake.
    await store.issues.setIssueUserState(
      fixtureWriteScope(),
      firstAdminMemberId(),
      asIssueId('iss_read'),
      {
        readAt: '2026-07-09T00:00:00.000Z',
      },
    )
    expect(
      (await store.issues.getIssueUserState(firstAdminMemberId(), asIssueId('iss_read')))?.tuckedAt,
    ).toBe('2026-07-08T00:00:00.000Z')

    // ANOTHER user's slice is empty for the SAME issue.
    expect(
      await store.issues.getIssueUserState(asUserId('user:other'), asIssueId('iss_read')),
    ).toBeUndefined()
    expect(
      (await store.issues.loadIssueUserStates(asUserId('user:other'), [asIssueId('iss_read')])).get(
        'iss_read',
      ),
    ).toBeUndefined()

    // Clearing every marker DELETES the row rather than leaving three nulls.
    await store.issues.setIssueUserState(
      fixtureWriteScope(),
      firstAdminMemberId(),
      asIssueId('iss_read'),
      {
        readAt: null,
        tuckedAt: null,
      },
    )
    expect(
      await store.issues.getIssueUserState(firstAdminMemberId(), asIssueId('iss_read')),
    ).toBeUndefined()

    // A write with no identity fails CLOSED; it never falls back to an operator.
    await expect(
      store.issues.setIssueUserState(fixtureWriteScope(), asUserId(''), asIssueId('iss_read'), {
        readAt: T1,
      }),
    ).rejects.toThrow(/no user id/)
    await store.close()
  })
})

describe('issue soft-delete persistence', () => {
  it('adds deleted_at and round-trips its tombstone', async () => {
    const store = await openIssueStore()
    expect((await issueColumns(store)).has('deleted_at')).toBe(true)
    const deletedAt = '2026-07-13T10:00:00.000Z'
    await store.issues.upsertIssue(fixtureWriteScope(), baseRow({ deletedAt }))
    expect((await store.issues.getIssue('iss_x'))?.deletedAt).toBe(deletedAt)
    await store.issues.upsertIssue(fixtureWriteScope(), baseRow())
    expect((await store.issues.getIssue('iss_x'))?.deletedAt).toBeNull()
  })
})

describe('needs_human data layer (P4)', () => {
  it('fresh DB has needs_human + human_question columns', async () => {
    const cols = await issueColumns(await openTestStore(':memory:'))
    expect(cols.has('needs_human'), 'missing column needs_human').toBe(true)
    expect(cols.has('human_question'), 'missing column human_question').toBe(true)
  })

  it('persists needsHuman + humanQuestion round-trip', async () => {
    const store = await openIssueStore()
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({ id: asIssueId('iss_x'), needsHuman: true, humanQuestion: 'which API key?' }),
    )
    const got = (await store.issues.getIssue('iss_x'))!
    expect(got.needsHuman).toBe(true)
    expect(got.humanQuestion).toBe('which API key?')
  })

  it('defaults needsHuman=false / humanQuestion=null when unset', async () => {
    const store = await openIssueStore()
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      baseRow({ id: asIssueId('iss_y'), needsHuman: false, humanQuestion: null }),
    )
    const y = (await store.issues.getIssue('iss_y'))!
    expect(y.needsHuman).toBe(false)
    expect(y.humanQuestion).toBeNull()
  })
})

describe('issue labels (P1)', () => {
  it('sets and reads (sorted) labels', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a', 'iss_b')
    await store.issues.setIssueLabels(asIssueId('iss_a'), ['ui', 'backend', 'ui'])
    await store.issues.setIssueLabels(asIssueId('iss_b'), ['backend'])
    expect(await store.issues.getIssueLabels(asIssueId('iss_a'))).toEqual(['backend', 'ui'])
    expect(await store.issues.getIssueLabels(asIssueId('iss_b'))).toEqual(['backend'])
  })

  it('setIssueLabels replaces the prior set', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a')
    await store.issues.setIssueLabels(asIssueId('iss_a'), ['x', 'y'])
    await store.issues.setIssueLabels(asIssueId('iss_a'), ['y', 'z'])
    expect(await store.issues.getIssueLabels(asIssueId('iss_a'))).toEqual(['y', 'z'])
  })
})

describe('issue deps (P1)', () => {
  it('adds, lists (both directions), and removes deps', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a', 'iss_b', 'iss_c')
    await store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_b'))
    await store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_c'), 'related')
    await store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_b')) // idempotent
    expect(await store.issues.listIssueDeps(asIssueId('iss_a'))).toEqual([
      { toId: 'iss_b', type: 'blocked-by' },
      { toId: 'iss_c', type: 'related' },
    ])
    expect(await store.issues.listDependents(asIssueId('iss_b'))).toEqual([
      { fromId: 'iss_a', type: 'blocked-by' },
    ])
    await store.issues.removeIssueDep(asIssueId('iss_a'), asIssueId('iss_b'))
    expect(await store.issues.listIssueDeps(asIssueId('iss_a'))).toEqual([
      { toId: 'iss_c', type: 'related' },
    ])
  })
})

describe('issue comments (P1)', () => {
  it('adds and lists comments oldest-first', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a', 'iss_b')
    await store.issues.addIssueComment({
      id: asIssueId('c1'),
      issueId: asIssueId('iss_a'),
      author: 'mike',
      body: 'first',
      createdAt: T1,
    })
    await store.issues.addIssueComment({
      id: asIssueId('c2'),
      issueId: asIssueId('iss_a'),
      author: 'agent',
      body: 'second',
      createdAt: T2,
    })
    await store.issues.addIssueComment({
      id: asIssueId('c3'),
      issueId: asIssueId('iss_b'),
      author: 'x',
      body: 'other',
      createdAt: T1,
    })
    const cs = await store.issues.listIssueComments(asIssueId('iss_a'))
    expect(cs.map((c) => c.body)).toEqual(['first', 'second'])
    expect(cs[0]!.author).toBe('mike')
  })
})

describe('issue mail store (agent mail #103)', () => {
  const msg = (id: string, issueId = asIssueId('iss_a'), createdAt = T1) => ({
    id,
    issueId,
    fromAuthor: 'issue:#2',
    body: `body ${id}`,
    createdAt,
    status: 'unread' as const,
    claimedBy: null,
    readAt: null,
    claimedAt: null,
  })

  it('creates the issue_messages table', async () => {
    expect((await tableNames(await openTestStore(':memory:'))).has('issue_messages')).toBe(true)
  })

  it('add/list/count: ordered by created_at,id; count only unread', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a', 'iss_other')
    await store.issues.addIssueMessage(msg('msg_b', asIssueId('iss_a'), T2))
    await store.issues.addIssueMessage(msg('msg_a', asIssueId('iss_a'), T1))
    await store.issues.addIssueMessage(msg('msg_c', asIssueId('iss_other'), T1))
    const list = await store.issues.listIssueMessages(asIssueId('iss_a'))
    expect(list.map((m) => m.id)).toEqual(['msg_a', 'msg_b'])
    expect(list[0]).toMatchObject({ issueId: 'iss_a', fromAuthor: 'issue:#2', status: 'unread' })
    expect(await store.issues.countUnreadIssueMessages(asIssueId('iss_a'))).toBe(2)
    await store.issues.markIssueMessagesRead(
      firstAdminMemberId(),
      asIssueId('iss_a'),
      ['msg_a'],
      T_READ,
    )
    expect(await store.issues.countUnreadIssueMessages(asIssueId('iss_a'))).toBe(1)
    expect(
      (await store.issues.listIssueMessages(asIssueId('iss_a'), { status: 'unread' })).map(
        (m) => m.id,
      ),
    ).toEqual(['msg_b'])
  })

  it('claim is atomic: second claim returns false and does not overwrite the winner', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a')
    await store.issues.addIssueMessage(msg('msg_a'))
    expect(await store.issues.claimIssueMessage('msg_a', 'issue:#3', T_CLAIM)).toBe(true)
    expect(await store.issues.claimIssueMessage('msg_a', 'issue:#4', T_CLAIM_2)).toBe(false)
    const m = (await store.issues.getIssueMessage('msg_a'))!
    expect(m.status).toBe('claimed')
    expect(m.claimedBy).toBe('issue:#3')
    expect(m.claimedAt).toBe(T_CLAIM)
  })

  it('markRead is idempotent and never regresses a claimed message', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a')
    await store.issues.addIssueMessage(msg('msg_a'))
    await store.issues.markIssueMessagesRead(
      firstAdminMemberId(),
      asIssueId('iss_a'),
      ['msg_a'],
      T1,
    )
    await store.issues.markIssueMessagesRead(
      firstAdminMemberId(),
      asIssueId('iss_a'),
      ['msg_a'],
      T2,
    )
    // TWO CLASSES, TWO BEHAVIOURS (POD-1076). `status` is the mail's SHARED
    // delivery state and is idempotent — the second call is a no-op on it. The
    // per-user `read_at` is a fact about THIS reader and DOES advance, because
    // "when did I last look at this" is not a once-only event.
    expect((await store.issues.getIssueMessage('msg_a'))!.status).toBe('read')
    expect((await store.issues.listIssueMessageReadAt(firstAdminMemberId())).msg_a).toBe(T2)
    // …and another reader has no marker for the same message.
    expect(await store.issues.listIssueMessageReadAt(asUserId('user:other'))).toEqual({})

    await store.issues.claimIssueMessage('msg_a', 'x', T_CLAIM)
    await store.issues.markIssueMessagesRead(
      firstAdminMemberId(),
      asIssueId('iss_a'),
      ['msg_a'],
      T3,
    )
    // Never regresses a claimed message back to 'read'…
    expect((await store.issues.getIssueMessage('msg_a'))!.status).toBe('claimed')
    // …but MY having read it after the claim is still true and is recorded.
    expect((await store.issues.listIssueMessageReadAt(firstAdminMemberId())).msg_a).toBe(T3)
  })

  it('deleteIssueChildRows removes the issue mailbox', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a', 'iss_other')
    await store.issues.addIssueMessage(msg('msg_a'))
    await store.issues.addIssueMessage(msg('msg_z', asIssueId('iss_other')))
    await store.issues.deleteIssueChildRows(asIssueId('iss_a'))
    expect(await store.issues.listIssueMessages(asIssueId('iss_a'))).toEqual([])
    expect((await store.issues.listIssueMessages(asIssueId('iss_other'))).length).toBe(1)
  })
})

describe('subscriptions store (Phase B)', () => {
  const sub = (
    over: Partial<import('./store').Subscription> = {},
  ): import('./store').Subscription => ({
    id: asIssueId('sub_a'),
    subscriberKind: 'issue',
    subscriberId: 'iss_p',
    event: 'issue.closed',
    sourceKind: 'relationship',
    sourceRef: 'my-children',
    deliverNudge: true,
    deliverNotify: false,
    origin: 'custom',
    enabled: true,
    createdAt: T1,
    ...over,
  })

  it('creates the subscriptions and subscription_deliveries tables', async () => {
    const t = await tableNames(await openTestStore(':memory:'))
    expect(t.has('subscriptions')).toBe(true)
    expect(t.has('subscription_deliveries')).toBe(true)
  })

  it('adds, lists (round-trips booleans), filters, and removes', async () => {
    const store = await openIssueStore()
    await store.events.addSubscription(sub())
    await store.events.addSubscription(
      sub({ id: 'sub_b', subscriberId: 'iss_other', deliverNotify: true, createdAt: T2 }),
    )
    const all = await store.events.listSubscriptionsPage()
    expect(all.map((s) => s.id)).toEqual(['sub_a', 'sub_b'])
    expect(all[0]).toMatchObject({
      deliverNudge: true,
      deliverNotify: false,
      enabled: true,
      origin: 'custom',
    })
    expect(all[1]!.deliverNotify).toBe(true)
    expect(
      (await store.events.listSubscriptions({ subscriberId: 'iss_p' })).map((s) => s.id),
    ).toEqual(['sub_a'])
    await store.events.removeSubscription('sub_a')
    expect((await store.events.listSubscriptionsPage()).map((s) => s.id)).toEqual(['sub_b'])
  })

  // The steward's read for one poll (POD-6208): only the rows that can match.
  const matching = async (
    store: SessionStore,
    q: { events: string[]; sources?: string[]; anchorIssueIds?: string[] },
  ) =>
    (
      await store.events.listMatchingSubscriptions({
        events: q.events,
        sources: q.sources ?? [],
        anchorIssueIds: q.anchorIssueIds ?? [],
      })
    ).map((s) => s.id)

  it('listMatchingSubscriptions omits disabled rows', async () => {
    const store = await openIssueStore()
    await store.events.addSubscription(sub({ id: 'sub_on', enabled: true }))
    await store.events.addSubscription(sub({ id: 'sub_off', enabled: false, createdAt: T2 }))
    expect(await matching(store, { events: ['issue.closed'], anchorIssueIds: ['iss_p'] })).toEqual([
      'sub_on',
    ])
  })

  it('listMatchingSubscriptions reads explicit sources by event and source', async () => {
    const store = await openIssueStore()
    const explicit = (id: string, over: Partial<import('./store').Subscription>) =>
      store.events.addSubscription(sub({ id, createdAt: stampOf(id), ...over }))
    await explicit('s1', { sourceKind: 'session', sourceRef: 'ses_a', event: 'session.finished' })
    await explicit('s2', { sourceKind: 'issue', sourceRef: 'iss_x', event: 'issue.closed' })
    await explicit('s3', { sourceKind: 'issue', sourceRef: 'iss_y', event: 'issue.closed' })
    await explicit('s4', { sourceKind: 'issue', sourceRef: 'iss_x', event: 'issue.updated' })
    await explicit('s5', { sourceKind: 'session', sourceRef: 'ses_b', event: 'session.finished' })
    expect(
      await matching(store, {
        events: ['issue.closed', 'session.finished'],
        sources: ['iss_x', 'ses_a'],
      }),
    ).toEqual(['s1', 's2'])
    // Nothing to match: no statement, no rows.
    expect(await matching(store, { events: ['issue.closed'] })).toEqual([])
    expect(await matching(store, { events: [], sources: ['iss_x'] })).toEqual([])
  })

  it('listMatchingSubscriptions reads relationship sources by their anchor subscriber', async () => {
    const store = await openIssueStore()
    const session = (id: string, issueId: string) =>
      store.sessions.upsertSession(fixtureWriteScope(), {
        id,
        ownerUserId: firstAdminMemberId(),
        agentKind: 'claude-code',
        cwd: '/r',
        title: id,
        name: null,
        originKind: 'spawn',
        conversationId: null,
        resumeKind: null,
        resumeValue: null,
        status: 'exited',
        exitCode: 0,
        durableLabel: `podium-${id}`,
        createdAt: T1,
        lastActiveAt: T1,
        lastOutputAt: null,
        lastInputAt: null,
        lastResumedAt: null,
        archived: false,
        workState: null,
        machineId: store.hostMachine!.id,
        headless: false,
        issueId: asIssueId(issueId),
        stoppedAt: null,
      } as never)
    await session('ses_on_p', 'iss_p')
    await session('ses_on_q', 'iss_q')
    await session('ses_gone', 'iss_p')
    await store.sessions.softDeleteSessions(fixtureWriteScope(), ['ses_gone'], T1, 'user' as never)
    const rel = (id: string, over: Partial<import('./store').Subscription>) =>
      store.events.addSubscription(sub({ id, createdAt: stampOf(id), ...over }))
    await rel('r1', { subscriberKind: 'issue', subscriberId: 'iss_p' })
    await rel('r2', { subscriberKind: 'issue', subscriberId: 'iss_q' })
    await rel('r3', { subscriberKind: 'session', subscriberId: 'ses_on_p' })
    await rel('r4', { subscriberKind: 'session', subscriberId: 'ses_on_q' })
    await rel('r5', { subscriberKind: 'session', subscriberId: 'ses_gone' })
    await rel('r6', { subscriberKind: 'issue', subscriberId: 'iss_p', event: 'issue.updated' })
    // An explicit source never comes in through its subscriber.
    await rel('r7', { subscriberId: 'iss_p', sourceKind: 'issue', sourceRef: 'iss_z' })
    expect(await matching(store, { events: ['issue.closed'], anchorIssueIds: ['iss_p'] })).toEqual([
      'r1',
      'r3',
    ])
    expect(await store.events.hasRelationshipSubscription(['issue.closed'])).toBe(true)
    expect(await store.events.hasRelationshipSubscription(['session.waiting'])).toBe(false)
    expect(await store.events.hasRelationshipSubscription([])).toBe(false)
  })

  it('listSubscriptionsPage pages every subscription oldest first by (created_at, id)', async () => {
    const store = await openIssueStore()
    for (const [id, createdAt] of [
      ['sub_c', T1],
      ['sub_a', T2],
      ['sub_b', T2],
      ['sub_d', T3],
    ] as const) {
      await store.events.addSubscription(sub({ id, createdAt }))
    }
    const first = await store.events.listSubscriptionsPage({ limit: 2 })
    expect(first.map((s) => s.id)).toEqual(['sub_c', 'sub_a'])
    const second = await store.events.listSubscriptionsPage({ after: first.at(-1)!, limit: 2 })
    expect(second.map((s) => s.id)).toEqual(['sub_b', 'sub_d'])
    expect(await store.events.listSubscriptionsPage({ after: second.at(-1)! })).toEqual([])
  })

  it('setSubscriptionEnabled toggles the flag and getSubscription reflects it', async () => {
    const store = await openIssueStore()
    await store.events.addSubscription(sub({ id: 'sub_t', enabled: true }))
    expect(await store.events.setSubscriptionEnabled('sub_t', false)).toBe(true)
    expect((await store.events.getSubscription('sub_t'))?.enabled).toBe(false)
    expect(await matching(store, { events: ['issue.closed'], anchorIssueIds: ['iss_p'] })).toEqual(
      [],
    )
    expect(await store.events.setSubscriptionEnabled('sub_t', true)).toBe(true)
    expect((await store.events.getSubscription('sub_t'))?.enabled).toBe(true)
    // Unknown id → no row updated.
    expect(await store.events.setSubscriptionEnabled('nope', false)).toBe(false)
    expect(await store.events.getSubscription('nope')).toBeUndefined()
  })

  it('markDelivered is idempotent per (subscription, event)', async () => {
    const store = await openIssueStore()
    expect(await store.events.markDelivered('sub_a', 5)).toBe(true)
    expect(await store.events.markDelivered('sub_a', 5)).toBe(false) // replay: already delivered
    expect(await store.events.markDelivered('sub_a', 6)).toBe(true) // a different event delivers
    expect(await store.events.markDelivered('sub_b', 5)).toBe(true) // a different sub delivers
  })
})

/**
 * READS THAT NAME THEIR INDEX (POD-7034). `liveChildrenOf` and
 * `issueIdsOfLabels` read through `idx_issues_children` and
 * `idx_issue_labels_label_id` with INDEXED BY and select their columns by bare
 * name; they return the rows and values the table-object reads did.
 */
describe('reads through a named index (POD-7034)', () => {
  it('liveChildrenOf returns the live children of the asked parents, mapped as before', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_p', 'iss_q', 'iss_alone')
    const child = (id: string, seq: number, parentId: string, over: Partial<IssueRow> = {}) =>
      store.issues.upsertIssue(
        fixtureWriteScope(),
        baseRow({ id: asIssueId(id), seq, parentId: asIssueId(parentId), ...over }),
      )
    await child('iss_c2', 202, 'iss_p', { stage: 'done', closedReason: 'done' })
    await child('iss_c1', 201, 'iss_p')
    await child('iss_gone', 203, 'iss_p', { deletedAt: '2026-11-16T00:00:00.000Z' })
    await child('iss_cq', 204, 'iss_q')
    expect(await store.issues.liveChildrenOf(['iss_p', 'iss_alone'])).toEqual([
      { id: 'iss_c1', parentId: 'iss_p', stage: 'backlog', closedReason: null, deletedAt: null },
      { id: 'iss_c2', parentId: 'iss_p', stage: 'done', closedReason: 'done', deletedAt: null },
    ])
    // Padded to a larger bucket, the same rows.
    expect(
      (await store.issues.liveChildrenOf(['iss_q', 'iss_p', 'iss_alone'])).map((c) => c.id),
    ).toEqual(['iss_c1', 'iss_c2', 'iss_cq'])
    expect(await store.issues.liveChildrenOf(['iss_alone'])).toEqual([])
  })

  it('issueIdsOfLabels returns each issue carrying one of the labels once', async () => {
    const store = await openIssueStore()
    await seedIssues(store, 'iss_a', 'iss_b', 'iss_c')
    await store.issues.setIssueLabels(asIssueId('iss_a'), ['red', 'blue'])
    await store.issues.setIssueLabels(asIssueId('iss_b'), ['blue'])
    await store.issues.setIssueLabels(asIssueId('iss_c'), ['green'])
    const ids = await store.issues.findLabels(['red', 'blue', 'green'])
    const red = ids.get('red')!.id
    const blue = ids.get('blue')!.id
    expect((await store.issues.issueIdsOfLabels([red, blue])).sort()).toEqual(['iss_a', 'iss_b'])
    expect(await store.issues.issueIdsOfLabels([ids.get('green')!.id])).toEqual(['iss_c'])
    expect(await store.issues.issueIdsOfLabels([])).toEqual([])
  })
})
