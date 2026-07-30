import { asIssueId, asSessionId, asUserId, SOLE_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueRow } from './store'
import { SessionStore } from './store'

function issueColumns(store: SessionStore): Set<string> {
  // @ts-expect-error reach the private db for a schema assertion
  const rows = store.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function tableNames(store: SessionStore): Set<string> {
  // @ts-expect-error private db
  const rows = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

describe('issues schema migration (P1)', () => {
  it('fresh DB has all new rich-field columns', () => {
    const cols = issueColumns(new SessionStore(':memory:'))
    for (const c of [
      'priority',
      'type',
      'assignee',
      'parent_id',
      'design',
      'acceptance',
      'notes',
      'due_at',
      'defer_until',
      'closed_reason',
      'superseded_by',
      'duplicate_of',
      // 'pinned' was here until POD-1076 re-keyed it onto `issue_user_state`; the
      // absence is asserted positively in the per-user describe block below, not
      // by silently shortening this list.
      'color',
      'estimate_min',
      // needs-human question metadata (issue #53, migration 018)
      'human_question_options',
      'human_question_asked_by',
      'human_question_asked_at',
    ]) {
      expect(cols.has(c), `missing column ${c}`).toBe(true)
    }
  })
})

describe('issues child tables (P1)', () => {
  it('creates issue_labels, issue_deps, issue_comments', () => {
    const t = tableNames(new SessionStore(':memory:'))
    expect(t.has('issue_labels')).toBe(true)
    expect(t.has('issue_deps')).toBe(true)
    expect(t.has('issue_comments')).toBe(true)
  })
})

function baseRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId('iss_x'),
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
    createdAt: 't',
    updatedAt: 't',
    archived: false,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null, closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    ...over,
  }
}

describe('needs-human question metadata round-trip (issue #53)', () => {
  it('persists options/askedBy/askedAt; corrupt options quarantine to null', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(
      baseRow({
        needsHuman: true,
        humanQuestion: 'merge?',
        humanQuestionOptions: ['Yes, merge', 'No', 'Later'],
        humanQuestionAskedBy: asSessionId('sess_1'),
        humanQuestionAskedAt: '2026-07-14T00:00:00.000Z',
      }),
    )
    const back = store.issues.getIssue('iss_x')!
    expect(back.humanQuestionOptions).toEqual(['Yes, merge', 'No', 'Later'])
    expect(back.humanQuestionAskedBy).toBe('sess_1')
    expect(back.humanQuestionAskedAt).toBe('2026-07-14T00:00:00.000Z')
    // A row literal without the optional fields (legacy shape) reads back null.
    store.issues.upsertIssue(baseRow({ id: asIssueId('iss_plain'), seq: 2, needsHuman: true }))
    const plain = store.issues.getIssue('iss_plain')!
    expect(plain.humanQuestionOptions).toBeNull()
    expect(plain.humanQuestionAskedBy).toBeNull()
    expect(plain.humanQuestionAskedAt).toBeNull()
    // Corrupt options JSON degrades to null (free-form question) — row survives.
    // @ts-expect-error private db
    store.db
      .prepare('UPDATE issues SET human_question_options = ? WHERE id = ?')
      .run('not-json', 'iss_x')
    expect(store.issues.getIssue('iss_x')!.humanQuestionOptions).toBeNull()
  })
})

/** Seed bare parent issues — FKs (migration 006) require referenced rows to exist. */
function seedIssues(store: SessionStore, ...ids: string[]): void {
  ids.forEach((id, i) => {
    store.issues.upsertIssue(baseRow({ id: asIssueId(id), seq: 100 + i }))
  })
}

describe('IssueRow rich fields round-trip (P1)', () => {
  it('persists and reads back new fields', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_epic', 'iss_new', 'iss_canon')
    store.issues.upsertIssue(
      baseRow({
        priority: 0,
        type: 'bug',
        assignee: asUserId('agent:claude'),
        parentId: asIssueId('iss_epic'),
        design: 'D',
        acceptance: 'A',
        notes: 'N',
        dueAt: '2026-07-01',
        deferUntil: '2026-07-05',
        closedReason: 'duplicate',
        supersededBy: asIssueId('iss_new'),
        duplicateOf: asIssueId('iss_canon'),
        color: 'violet',
        estimateMin: 30,
      }),
    )
    const r = store.issues.getIssue('iss_x')!
    expect(r.priority).toBe(0)
    expect(r.type).toBe('bug')
    expect(r.assignee).toBe('agent:claude')
    expect(r.parentId).toBe('iss_epic')
    expect(r.color).toBe('violet')
    expect(r.estimateMin).toBe(30)
    expect(r.deferUntil).toBe('2026-07-05')
    expect(r.closedReason).toBe('duplicate')
  })

  it('defaults are applied for a minimal legacy-style insert', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(baseRow())
    const r = store.issues.getIssue('iss_x')!
    expect(r.priority).toBe(2)
    expect(r.type).toBe('task')
    expect(r.color).toBeNull()
  })

  it('persists palette slots and clears them back to null', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(baseRow({ color: 'teal' }))
    expect(store.issues.getIssue('iss_x')?.color).toBe('teal')
    store.issues.upsertIssue(baseRow({ color: null }))
    expect(store.issues.getIssue('iss_x')?.color).toBeNull()
  })
})

// PER-USER issue state (POD-1076). This used to assert that `read_at` was an
// additive COLUMN on `issues`; the re-key inverted it, so the flipped form asserts
// the column is gone and the marker is one person's row.
describe('per-user issue state (POD-1076)', () => {
  it('the three markers are NOT columns on the shared issue row', () => {
    const cols = issueColumns(new SessionStore(':memory:'))
    // The instrument can say YES about a column that IS there — without this,
    // every absence claim below would pass against a table it failed to read.
    expect(cols.has('stage')).toBe(true)
    expect(cols.has('read_at')).toBe(false)
    expect(cols.has('tucked_at')).toBe(false)
    expect(cols.has('pinned')).toBe(false)
  })

  it('persists all three markers on ONE (userId, issueId) row, per user', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(baseRow({ id: asIssueId('iss_read') }))
    // Distinct seq — UNIQUE(repo_path, seq) is enforced since migration 004.
    store.issues.upsertIssue(baseRow({ id: asIssueId('iss_untouched'), seq: 2 }))

    store.issues.setIssueUserState(SOLE_USER_ID, 'iss_read', {
      readAt: '2026-07-07T00:00:00.000Z',
      pinnedAt: '2026-07-08T00:00:00.000Z',
    })
    expect(store.issues.getIssueUserState(SOLE_USER_ID, 'iss_read')).toEqual({
      readAt: '2026-07-07T00:00:00.000Z',
      tuckedAt: null,
      pinnedAt: '2026-07-08T00:00:00.000Z',
    })
    // An issue nobody touched has NO row — absence is the single spelling.
    expect(store.issues.getIssueUserState(SOLE_USER_ID, 'iss_untouched')).toBeUndefined()

    // The PARTIAL patch: writing readAt must not disturb pinnedAt. This is the
    // whole reason the method takes a patch rather than a row — a whole-row
    // upsert makes "marking it read un-pinned it" a one-line mistake.
    store.issues.setIssueUserState(SOLE_USER_ID, 'iss_read', { readAt: '2026-07-09T00:00:00.000Z' })
    expect(store.issues.getIssueUserState(SOLE_USER_ID, 'iss_read')?.pinnedAt).toBe(
      '2026-07-08T00:00:00.000Z',
    )

    // ANOTHER user's slice is empty for the SAME issue.
    expect(store.issues.getIssueUserState('user:other', 'iss_read')).toBeUndefined()
    expect(store.issues.listIssueUserState('user:other').size).toBe(0)

    // Clearing every marker DELETES the row rather than leaving three nulls.
    store.issues.setIssueUserState(SOLE_USER_ID, 'iss_read', { readAt: null, pinnedAt: null })
    expect(store.issues.getIssueUserState(SOLE_USER_ID, 'iss_read')).toBeUndefined()

    // A write with no identity fails CLOSED; it never falls back to an operator.
    expect(() => store.issues.setIssueUserState('', 'iss_read', { readAt: 't' })).toThrow(
      /no user id/,
    )
    store.close()
  })
})

describe('issue soft-delete persistence', () => {
  it('adds deleted_at and round-trips its tombstone', () => {
    const store = new SessionStore(':memory:')
    expect(issueColumns(store).has('deleted_at')).toBe(true)
    const deletedAt = '2026-07-13T10:00:00.000Z'
    store.issues.upsertIssue(baseRow({ deletedAt }))
    expect(store.issues.getIssue('iss_x')?.deletedAt).toBe(deletedAt)
    store.issues.upsertIssue(baseRow())
    expect(store.issues.getIssue('iss_x')?.deletedAt).toBeNull()
  })
})

describe('needs_human data layer (P4)', () => {
  it('fresh DB has needs_human + human_question columns', () => {
    const cols = issueColumns(new SessionStore(':memory:'))
    expect(cols.has('needs_human'), 'missing column needs_human').toBe(true)
    expect(cols.has('human_question'), 'missing column human_question').toBe(true)
  })

  it('persists needsHuman + humanQuestion round-trip', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(
      baseRow({ id: asIssueId('iss_x'), needsHuman: true, humanQuestion: 'which API key?' }),
    )
    const got = store.issues.getIssue('iss_x')!
    expect(got.needsHuman).toBe(true)
    expect(got.humanQuestion).toBe('which API key?')
  })

  it('defaults needsHuman=false / humanQuestion=null when unset', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(baseRow({ id: asIssueId('iss_y'), needsHuman: false, humanQuestion: null }))
    const y = store.issues.getIssue('iss_y')!
    expect(y.needsHuman).toBe(false)
    expect(y.humanQuestion).toBeNull()
  })
})

describe('issue labels (P1)', () => {
  it('sets, reads (sorted), and lists distinct labels', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_b')
    store.issues.setIssueLabels('iss_a', ['ui', 'backend', 'ui'])
    store.issues.setIssueLabels('iss_b', ['backend'])
    expect(store.issues.getIssueLabels('iss_a')).toEqual(['backend', 'ui'])
    expect(store.issues.listAllLabels()).toEqual(['backend', 'ui'])
  })

  it('setIssueLabels replaces the prior set', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a')
    store.issues.setIssueLabels('iss_a', ['x', 'y'])
    store.issues.setIssueLabels('iss_a', ['y', 'z'])
    expect(store.issues.getIssueLabels('iss_a')).toEqual(['y', 'z'])
  })
})

describe('issue deps (P1)', () => {
  it('adds, lists (both directions), and removes deps', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_b', 'iss_c')
    store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_b'))
    store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_c'), 'related')
    store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_b')) // idempotent
    expect(store.issues.listIssueDeps(asIssueId('iss_a'))).toEqual([
      { toId: 'iss_b', type: 'blocks' },
      { toId: 'iss_c', type: 'related' },
    ])
    expect(store.issues.listDependents(asIssueId('iss_b'))).toEqual([{ fromId: 'iss_a', type: 'blocks' }])
    store.issues.removeIssueDep(asIssueId('iss_a'), asIssueId('iss_b'))
    expect(store.issues.listIssueDeps(asIssueId('iss_a'))).toEqual([{ toId: 'iss_c', type: 'related' }])
  })
})

describe('issue comments (P1)', () => {
  it('adds and lists comments oldest-first', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_b')
    store.issues.addIssueComment({
      id: asIssueId('c1'),
      issueId: asIssueId('iss_a'),
      author: 'mike',
      body: 'first',
      createdAt: 't1',
    })
    store.issues.addIssueComment({
      id: asIssueId('c2'),
      issueId: asIssueId('iss_a'),
      author: 'agent',
      body: 'second',
      createdAt: 't2',
    })
    store.issues.addIssueComment({
      id: asIssueId('c3'),
      issueId: asIssueId('iss_b'),
      author: 'x',
      body: 'other',
      createdAt: 't1',
    })
    const cs = store.issues.listIssueComments(asIssueId('iss_a'))
    expect(cs.map((c) => c.body)).toEqual(['first', 'second'])
    expect(cs[0]!.author).toBe('mike')
  })
})

describe('issue mail store (agent mail #103)', () => {
  const msg = (id: string, issueId = asIssueId('iss_a'), createdAt = 't1') => ({
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

  it('creates the issue_messages table', () => {
    expect(tableNames(new SessionStore(':memory:')).has('issue_messages')).toBe(true)
  })

  it('add/list/count: ordered by created_at,id; count only unread', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_other')
    store.issues.addIssueMessage(msg('msg_b', asIssueId('iss_a'), 't2'))
    store.issues.addIssueMessage(msg('msg_a', asIssueId('iss_a'), 't1'))
    store.issues.addIssueMessage(msg('msg_c', asIssueId('iss_other'), 't1'))
    const list = store.issues.listIssueMessages('iss_a')
    expect(list.map((m) => m.id)).toEqual(['msg_a', 'msg_b'])
    expect(list[0]).toMatchObject({ issueId: 'iss_a', fromAuthor: 'issue:#2', status: 'unread' })
    expect(store.issues.countUnreadIssueMessages('iss_a')).toBe(2)
    store.issues.markIssueMessagesRead(SOLE_USER_ID, 'iss_a', ['msg_a'], 'tr')
    expect(store.issues.countUnreadIssueMessages('iss_a')).toBe(1)
    expect(store.issues.listIssueMessages('iss_a', { status: 'unread' }).map((m) => m.id)).toEqual([
      'msg_b',
    ])
  })

  it('claim is atomic: second claim returns false and does not overwrite the winner', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a')
    store.issues.addIssueMessage(msg('msg_a'))
    expect(store.issues.claimIssueMessage('msg_a', 'issue:#3', 'tc')).toBe(true)
    expect(store.issues.claimIssueMessage('msg_a', 'issue:#4', 'tc2')).toBe(false)
    const m = store.issues.getIssueMessage('msg_a')!
    expect(m.status).toBe('claimed')
    expect(m.claimedBy).toBe('issue:#3')
    expect(m.claimedAt).toBe('tc')
  })

  it('markRead is idempotent and never regresses a claimed message', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a')
    store.issues.addIssueMessage(msg('msg_a'))
    store.issues.markIssueMessagesRead(SOLE_USER_ID, 'iss_a', ['msg_a'], 't1')
    store.issues.markIssueMessagesRead(SOLE_USER_ID, 'iss_a', ['msg_a'], 't2')
    // TWO CLASSES, TWO BEHAVIOURS (POD-1076). `status` is the mail's SHARED
    // delivery state and is idempotent — the second call is a no-op on it. The
    // per-user `read_at` is a fact about THIS reader and DOES advance, because
    // "when did I last look at this" is not a once-only event.
    expect(store.issues.getIssueMessage('msg_a')!.status).toBe('read')
    expect(store.issues.listIssueMessageReadAt(SOLE_USER_ID).msg_a).toBe('t2')
    // …and another reader has no marker for the same message.
    expect(store.issues.listIssueMessageReadAt('user:other')).toEqual({})

    store.issues.claimIssueMessage('msg_a', 'x', 'tc')
    store.issues.markIssueMessagesRead(SOLE_USER_ID, 'iss_a', ['msg_a'], 't3')
    // Never regresses a claimed message back to 'read'…
    expect(store.issues.getIssueMessage('msg_a')!.status).toBe('claimed')
    // …but MY having read it after the claim is still true and is recorded.
    expect(store.issues.listIssueMessageReadAt(SOLE_USER_ID).msg_a).toBe('t3')
  })

  it('deleteIssueChildRows removes the issue mailbox', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_other')
    store.issues.addIssueMessage(msg('msg_a'))
    store.issues.addIssueMessage(msg('msg_z', asIssueId('iss_other')))
    store.issues.deleteIssueChildRows('iss_a')
    expect(store.issues.listIssueMessages('iss_a')).toEqual([])
    expect(store.issues.listIssueMessages('iss_other').length).toBe(1)
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
    createdAt: 't1',
    ...over,
  })

  it('creates the subscriptions and subscription_deliveries tables', () => {
    const t = tableNames(new SessionStore(':memory:'))
    expect(t.has('subscriptions')).toBe(true)
    expect(t.has('subscription_deliveries')).toBe(true)
  })

  it('adds, lists (round-trips booleans), filters, and removes', () => {
    const store = new SessionStore(':memory:')
    store.events.addSubscription(sub())
    store.events.addSubscription(
      sub({ id: 'sub_b', subscriberId: 'iss_other', deliverNotify: true, createdAt: 't2' }),
    )
    const all = store.events.listSubscriptions()
    expect(all.map((s) => s.id)).toEqual(['sub_a', 'sub_b'])
    expect(all[0]).toMatchObject({
      deliverNudge: true,
      deliverNotify: false,
      enabled: true,
      origin: 'custom',
    })
    expect(all[1]!.deliverNotify).toBe(true)
    expect(store.events.listSubscriptions({ subscriberId: 'iss_p' }).map((s) => s.id)).toEqual([
      'sub_a',
    ])
    store.events.removeSubscription('sub_a')
    expect(store.events.listSubscriptions().map((s) => s.id)).toEqual(['sub_b'])
  })

  it('listEnabledSubscriptions omits disabled rows', () => {
    const store = new SessionStore(':memory:')
    store.events.addSubscription(sub({ id: 'sub_on', enabled: true }))
    store.events.addSubscription(sub({ id: 'sub_off', enabled: false, createdAt: 't2' }))
    expect(store.events.listEnabledSubscriptions().map((s) => s.id)).toEqual(['sub_on'])
  })

  it('setSubscriptionEnabled toggles the flag and getSubscription reflects it', () => {
    const store = new SessionStore(':memory:')
    store.events.addSubscription(sub({ id: 'sub_t', enabled: true }))
    expect(store.events.setSubscriptionEnabled('sub_t', false)).toBe(true)
    expect(store.events.getSubscription('sub_t')?.enabled).toBe(false)
    expect(store.events.listEnabledSubscriptions().map((s) => s.id)).toEqual([])
    expect(store.events.setSubscriptionEnabled('sub_t', true)).toBe(true)
    expect(store.events.getSubscription('sub_t')?.enabled).toBe(true)
    // Unknown id → no row updated.
    expect(store.events.setSubscriptionEnabled('nope', false)).toBe(false)
    expect(store.events.getSubscription('nope')).toBeUndefined()
  })

  it('markDelivered is idempotent per (subscription, event)', () => {
    const store = new SessionStore(':memory:')
    expect(store.events.markDelivered('sub_a', 5)).toBe(true)
    expect(store.events.markDelivered('sub_a', 5)).toBe(false) // replay: already delivered
    expect(store.events.markDelivered('sub_a', 6)).toBe(true) // a different event delivers
    expect(store.events.markDelivered('sub_b', 5)).toBe(true) // a different sub delivers
  })
})
