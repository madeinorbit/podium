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
      'pinned',
      'estimate_min',
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
    id: 'iss_x',
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
    closedReason: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: false,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    ...over,
  }
}

/** Seed bare parent issues — FKs (migration 006) require referenced rows to exist. */
function seedIssues(store: SessionStore, ...ids: string[]): void {
  ids.forEach((id, i) => store.upsertIssue(baseRow({ id, seq: 100 + i })))
}

describe('IssueRow rich fields round-trip (P1)', () => {
  it('persists and reads back new fields', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_epic', 'iss_new', 'iss_canon')
    store.upsertIssue(
      baseRow({
        priority: 0,
        type: 'bug',
        assignee: 'agent:claude',
        parentId: 'iss_epic',
        design: 'D',
        acceptance: 'A',
        notes: 'N',
        dueAt: '2026-07-01',
        deferUntil: '2026-07-05',
        closedReason: 'duplicate',
        supersededBy: 'iss_new',
        duplicateOf: 'iss_canon',
        pinned: true,
        estimateMin: 30,
      }),
    )
    const r = store.getIssue('iss_x')!
    expect(r.priority).toBe(0)
    expect(r.type).toBe('bug')
    expect(r.assignee).toBe('agent:claude')
    expect(r.parentId).toBe('iss_epic')
    expect(r.pinned).toBe(true)
    expect(r.estimateMin).toBe(30)
    expect(r.deferUntil).toBe('2026-07-05')
    expect(r.closedReason).toBe('duplicate')
  })

  it('defaults are applied for a minimal legacy-style insert', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow())
    const r = store.getIssue('iss_x')!
    expect(r.priority).toBe(2)
    expect(r.type).toBe('task')
    expect(r.pinned).toBe(false)
  })
})

// Email-style read state (issue #124) persists like any other additive column.
describe('issue read state persistence (#124)', () => {
  it('fresh DB has the read_at column', () => {
    expect(issueColumns(new SessionStore(':memory:')).has('read_at')).toBe(true)
  })

  it('persists and reads back read_at; a row that never had it reads null', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow({ id: 'iss_read', readAt: '2026-07-07T00:00:00.000Z' }))
    // Distinct seq — UNIQUE(repo_path, seq) is enforced since migration 004.
    store.upsertIssue(baseRow({ id: 'iss_unread', seq: 2 }))
    expect(store.getIssue('iss_read')!.readAt).toBe('2026-07-07T00:00:00.000Z')
    expect(store.getIssue('iss_unread')!.readAt).toBeNull()
    store.close()
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
    store.upsertIssue(baseRow({ id: 'iss_x', needsHuman: true, humanQuestion: 'which API key?' }))
    const got = store.getIssue('iss_x')!
    expect(got.needsHuman).toBe(true)
    expect(got.humanQuestion).toBe('which API key?')
  })

  it('defaults needsHuman=false / humanQuestion=null when unset', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow({ id: 'iss_y', needsHuman: false, humanQuestion: null }))
    const y = store.getIssue('iss_y')!
    expect(y.needsHuman).toBe(false)
    expect(y.humanQuestion).toBeNull()
  })
})

describe('issue labels (P1)', () => {
  it('sets, reads (sorted), and lists distinct labels', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_b')
    store.setIssueLabels('iss_a', ['ui', 'backend', 'ui'])
    store.setIssueLabels('iss_b', ['backend'])
    expect(store.getIssueLabels('iss_a')).toEqual(['backend', 'ui'])
    expect(store.listAllLabels()).toEqual(['backend', 'ui'])
  })

  it('setIssueLabels replaces the prior set', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a')
    store.setIssueLabels('iss_a', ['x', 'y'])
    store.setIssueLabels('iss_a', ['y', 'z'])
    expect(store.getIssueLabels('iss_a')).toEqual(['y', 'z'])
  })
})

describe('issue deps (P1)', () => {
  it('adds, lists (both directions), and removes deps', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_b', 'iss_c')
    store.addIssueDep('iss_a', 'iss_b')
    store.addIssueDep('iss_a', 'iss_c', 'related')
    store.addIssueDep('iss_a', 'iss_b') // idempotent
    expect(store.listIssueDeps('iss_a')).toEqual([
      { toId: 'iss_b', type: 'blocks' },
      { toId: 'iss_c', type: 'related' },
    ])
    expect(store.listDependents('iss_b')).toEqual([{ fromId: 'iss_a', type: 'blocks' }])
    store.removeIssueDep('iss_a', 'iss_b')
    expect(store.listIssueDeps('iss_a')).toEqual([{ toId: 'iss_c', type: 'related' }])
  })
})

describe('issue comments (P1)', () => {
  it('adds and lists comments oldest-first', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_b')
    store.addIssueComment({
      id: 'c1',
      issueId: 'iss_a',
      author: 'mike',
      body: 'first',
      createdAt: 't1',
    })
    store.addIssueComment({
      id: 'c2',
      issueId: 'iss_a',
      author: 'agent',
      body: 'second',
      createdAt: 't2',
    })
    store.addIssueComment({
      id: 'c3',
      issueId: 'iss_b',
      author: 'x',
      body: 'other',
      createdAt: 't1',
    })
    const cs = store.listIssueComments('iss_a')
    expect(cs.map((c) => c.body)).toEqual(['first', 'second'])
    expect(cs[0]!.author).toBe('mike')
  })
})

describe('issue mail store (agent mail #103)', () => {
  const msg = (id: string, issueId = 'iss_a', createdAt = 't1') => ({
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
    store.addIssueMessage(msg('msg_b', 'iss_a', 't2'))
    store.addIssueMessage(msg('msg_a', 'iss_a', 't1'))
    store.addIssueMessage(msg('msg_c', 'iss_other', 't1'))
    const list = store.listIssueMessages('iss_a')
    expect(list.map((m) => m.id)).toEqual(['msg_a', 'msg_b'])
    expect(list[0]).toMatchObject({ issueId: 'iss_a', fromAuthor: 'issue:#2', status: 'unread' })
    expect(store.countUnreadIssueMessages('iss_a')).toBe(2)
    store.markIssueMessagesRead('iss_a', ['msg_a'], 'tr')
    expect(store.countUnreadIssueMessages('iss_a')).toBe(1)
    expect(store.listIssueMessages('iss_a', { status: 'unread' }).map((m) => m.id)).toEqual([
      'msg_b',
    ])
  })

  it('claim is atomic: second claim returns false and does not overwrite the winner', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a')
    store.addIssueMessage(msg('msg_a'))
    expect(store.claimIssueMessage('msg_a', 'issue:#3', 'tc')).toBe(true)
    expect(store.claimIssueMessage('msg_a', 'issue:#4', 'tc2')).toBe(false)
    const m = store.getIssueMessage('msg_a')!
    expect(m.status).toBe('claimed')
    expect(m.claimedBy).toBe('issue:#3')
    expect(m.claimedAt).toBe('tc')
  })

  it('markRead is idempotent and never regresses a claimed message', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a')
    store.addIssueMessage(msg('msg_a'))
    store.markIssueMessagesRead('iss_a', ['msg_a'], 't1')
    store.markIssueMessagesRead('iss_a', ['msg_a'], 't2') // already read: no-op
    expect(store.getIssueMessage('msg_a')).toMatchObject({ status: 'read', readAt: 't1' })
    store.claimIssueMessage('msg_a', 'x', 'tc')
    store.markIssueMessagesRead('iss_a', ['msg_a'], 't3')
    expect(store.getIssueMessage('msg_a')!.status).toBe('claimed')
  })

  it('deleteIssueChildRows removes the issue mailbox', () => {
    const store = new SessionStore(':memory:')
    seedIssues(store, 'iss_a', 'iss_other')
    store.addIssueMessage(msg('msg_a'))
    store.addIssueMessage(msg('msg_z', 'iss_other'))
    store.deleteIssueChildRows('iss_a')
    expect(store.listIssueMessages('iss_a')).toEqual([])
    expect(store.listIssueMessages('iss_other').length).toBe(1)
  })
})

describe('subscriptions store (Phase B)', () => {
  const sub = (
    over: Partial<import('./store').Subscription> = {},
  ): import('./store').Subscription => ({
    id: 'sub_a',
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
    store.addSubscription(sub())
    store.addSubscription(
      sub({ id: 'sub_b', subscriberId: 'iss_other', deliverNotify: true, createdAt: 't2' }),
    )
    const all = store.listSubscriptions()
    expect(all.map((s) => s.id)).toEqual(['sub_a', 'sub_b'])
    expect(all[0]).toMatchObject({
      deliverNudge: true,
      deliverNotify: false,
      enabled: true,
      origin: 'custom',
    })
    expect(all[1]!.deliverNotify).toBe(true)
    expect(store.listSubscriptions({ subscriberId: 'iss_p' }).map((s) => s.id)).toEqual(['sub_a'])
    store.removeSubscription('sub_a')
    expect(store.listSubscriptions().map((s) => s.id)).toEqual(['sub_b'])
  })

  it('listEnabledSubscriptions omits disabled rows', () => {
    const store = new SessionStore(':memory:')
    store.addSubscription(sub({ id: 'sub_on', enabled: true }))
    store.addSubscription(sub({ id: 'sub_off', enabled: false, createdAt: 't2' }))
    expect(store.listEnabledSubscriptions().map((s) => s.id)).toEqual(['sub_on'])
  })

  it('setSubscriptionEnabled toggles the flag and getSubscription reflects it', () => {
    const store = new SessionStore(':memory:')
    store.addSubscription(sub({ id: 'sub_t', enabled: true }))
    expect(store.setSubscriptionEnabled('sub_t', false)).toBe(true)
    expect(store.getSubscription('sub_t')?.enabled).toBe(false)
    expect(store.listEnabledSubscriptions().map((s) => s.id)).toEqual([])
    expect(store.setSubscriptionEnabled('sub_t', true)).toBe(true)
    expect(store.getSubscription('sub_t')?.enabled).toBe(true)
    // Unknown id → no row updated.
    expect(store.setSubscriptionEnabled('nope', false)).toBe(false)
    expect(store.getSubscription('nope')).toBeUndefined()
  })

  it('markDelivered is idempotent per (subscription, event)', () => {
    const store = new SessionStore(':memory:')
    expect(store.markDelivered('sub_a', 5)).toBe(true)
    expect(store.markDelivered('sub_a', 5)).toBe(false) // replay: already delivered
    expect(store.markDelivered('sub_a', 6)).toBe(true) // a different event delivers
    expect(store.markDelivered('sub_b', 5)).toBe(true) // a different sub delivers
  })
})
