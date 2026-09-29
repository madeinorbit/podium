/**
 * A REMOVED SESSION TAKES ITS WAITING MESSAGES WITH IT (POD-4816).
 *
 * Deleting a session drops its queue in the tombstone's transaction; before
 * this, the messages that queue held stayed open forever and their senders were
 * never told. Through the real composition: kill and issue deletion each fail
 * every open message bound to the session, with its sender's notice, in the
 * same commit as the tombstone — and a rolled-back tombstone takes the failures
 * back with it.
 */
import { asThreadId, type MessageDeliveryStatus, type SessionId } from '@podium/model'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { failureNoticeId } from './message-ids'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { seedMessage } from './test-support/seed-message'

async function registryWithDaemon() {
  const store = await openTestStore(':memory:')
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(registry, () => {}, { repos: ['/repo'] })
  onTestFinished(async () => await registry.dispose())
  return { registry, store }
}

let seq = 0
async function seed(
  store: SessionStore,
  input: {
    from: SessionId
    to: { kind: 'session' | 'issue'; id: string }
    status: MessageDeliveryStatus
    handedTo?: SessionId
  },
): Promise<string> {
  const id = `msg_removal_${++seq}`
  await seedMessage(store.messages, {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: input.from,
    fromIssue: null,
    toKind: input.to.kind,
    toId: input.to.id,
    kind: 'message',
    urgency: 'next-turn',
    lifecycle: 'wait',
    body: `message ${id}`,
    expiresAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 29, 12, 0, seq)).toISOString(),
    deliveryStatus: input.status,
    deliveredAt: null,
    deliveredTo: input.handedTo ?? null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
  })
  return id
}

const statusOf = async (store: SessionStore, id: string) =>
  (await store.messages.getMessage(id))?.deliveryStatus
const noticeOf = async (store: SessionStore, id: string) =>
  await store.messages.getMessage(failureNoticeId(id))

describe('a removed session takes its waiting messages with it (POD-4816)', () => {
  it('kill fails every open message for the session, each sender told once, a confirmed one untouched', async () => {
    const { registry, store } = await registryWithDaemon()
    const create = async () =>
      (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo' })).sessionId
    const sender = await create()
    const target = await create()
    const toTarget = { kind: 'session', id: target } as const
    const stored = await seed(store, { from: sender, to: toTarget, status: 'stored' })
    const handed = await seed(store, { from: sender, to: toTarget, status: 'dispatched', handedTo: target })
    const typed = await seed(store, { from: sender, to: toTarget, status: 'typed', handedTo: target })
    const confirmed = await seed(store, { from: sender, to: toTarget, status: 'confirmed', handedTo: target })

    await registry.modules.sessions.killSession({ sessionId: target })

    for (const id of [stored, handed, typed]) {
      expect(await store.messages.getMessage(id)).toMatchObject({
        deliveryStatus: 'failed',
        deliveryDeferredReason: null,
      })
      expect(await noticeOf(store, id)).toMatchObject({ toKind: 'session', toId: sender, fromKind: 'system' })
    }
    expect((await noticeOf(store, handed))?.body).toContain(
      `to session ${target} was not delivered: that session has ended.`,
    )
    expect((await noticeOf(store, typed))?.body).toContain(
      `to session ${target} may not have been delivered: that session ended before anything confirmed it arrived`,
    )
    expect(await statusOf(store, confirmed)).toBe('confirmed')
    expect(await noticeOf(store, confirmed)).toBeNull()

    // A repeated delete finds nothing open and tells nobody twice.
    const before = await store.messages.listLedger({ limit: 100 })
    await registry.modules.sessions.killSession({ sessionId: target })
    expect(await store.messages.listLedger({ limit: 100 })).toHaveLength(before.length)
  })

  it('fails the messages in the tombstone’s own commit: a tombstone that rolls back leaves them open', async () => {
    const { registry, store } = await registryWithDaemon()
    const create = async () =>
      (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo' })).sessionId
    const sender = await create()
    const target = await create()
    const handed = await seed(store, {
      from: sender, to: { kind: 'session', id: target }, status: 'dispatched', handedTo: target,
    })
    vi.spyOn(store.sessions, 'softDeleteSessions').mockImplementationOnce(async () => {
      throw new Error('tombstone failed')
    })

    await expect(registry.modules.sessions.killSession({ sessionId: target })).rejects.toThrow('tombstone failed')

    expect(await statusOf(store, handed)).toBe('dispatched')
    expect(await noticeOf(store, handed)).toBeNull()
    expect((await registry.modules.sessions.listSessions(undefined, 'rpc')).some((s) => s.sessionId === target))
      .toBe(true)
  })

  it('issue deletion fails its sessions’ messages as the issue’s end', async () => {
    const { registry, store } = await registryWithDaemon()
    const issue = await registry.issues.create({ repoPath: '/repo', title: 'Going away', startNow: false })
    const sender = (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo' })).sessionId
    const member = (await registry.modules.sessions.createSession({
      agentKind: 'shell', cwd: '/repo', issueId: issue.id,
    })).sessionId
    const toMember = await seed(store, {
      from: sender, to: { kind: 'session', id: member }, status: 'dispatched', handedTo: member,
    })
    const toIssue = await seed(store, {
      from: sender, to: { kind: 'issue', id: issue.id }, status: 'dispatched', handedTo: member,
    })

    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)

    expect(await statusOf(store, toMember)).toBe('failed')
    expect((await noticeOf(store, toMember))?.body).toContain(
      'that session has ended. Nobody else holds that conversation; do not wait for a reply.',
    )
    expect(await statusOf(store, toIssue)).toBe('failed')
    expect((await noticeOf(store, toIssue))?.body).toContain('was deleted. Do not wait for a reply.')
  })

  it('a stored issue message is bound to its issue, not to the session that is killed', async () => {
    const { registry, store } = await registryWithDaemon()
    const issue = await registry.issues.create({ repoPath: '/repo', title: 'Stays', startNow: false })
    const sender = (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo' })).sessionId
    const member = (await registry.modules.sessions.createSession({
      agentKind: 'shell', cwd: '/repo', issueId: issue.id,
    })).sessionId
    // `stored` is what says it was never handed on, whatever `delivered_to`
    // holds: a row can be stored with one already named.
    const held = await seed(store, {
      from: sender, to: { kind: 'issue', id: issue.id }, status: 'stored', handedTo: member,
    })
    const handed = await seed(store, {
      from: sender, to: { kind: 'issue', id: issue.id }, status: 'dispatched', handedTo: member,
    })

    await registry.modules.sessions.killSession({ sessionId: member })

    // Handed to the killed session: stranded with it, so it ends, pointing the
    // sender back at the issue, which is still open.
    expect(await statusOf(store, handed)).toBe('failed')
    expect((await noticeOf(store, handed))?.body).toContain('the session it was handed to has ended.')
    expect((await noticeOf(store, handed))?.body).toContain('to reach whoever works it now.')
    // Never handed on: still the issue's, for whoever works it next.
    expect(await statusOf(store, held)).not.toBe('failed')
    expect(await noticeOf(store, held)).toBeNull()
  })
})

describe('a deleted issue takes the messages still waiting for it (POD-4817)', () => {
  async function withIssue(title: string) {
    const { registry, store } = await registryWithDaemon()
    const issue = await registry.issues.create({ repoPath: '/repo', title, startNow: false })
    const sender = (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/repo' })).sessionId
    return { registry, store, issue, sender }
  }

  it('fails a message never handed on, with its sender told in the deletion’s commit; restore does not reopen it', async () => {
    const { registry, store, issue, sender } = await withIssue('Deleted with mail waiting')
    const other = await registry.issues.create({ repoPath: '/repo', title: 'Stays', startNow: false })
    const held = await seed(store, { from: sender, to: { kind: 'issue', id: issue.id }, status: 'stored' })
    const elsewhere = await seed(store, { from: sender, to: { kind: 'issue', id: other.id }, status: 'stored' })

    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)

    expect(await store.messages.getMessage(held)).toMatchObject({
      deliveryStatus: 'failed',
      deliveryDeferredReason: null,
    })
    const notice = await noticeOf(store, held)
    expect(notice).toMatchObject({ toKind: 'session', toId: sender, fromKind: 'system' })
    expect(notice?.body).toContain('was not delivered: ')
    expect(notice?.body).toContain('was deleted. Do not wait for a reply.')
    expect(await statusOf(store, elsewhere)).toBe('stored')
    expect(await noticeOf(store, elsewhere)).toBeNull()

    // The sender was told not to wait; bringing the issue back does not
    // resurrect a message it already gave up on.
    await registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
    expect(await statusOf(store, held)).toBe('failed')
  })

  it('a deletion that rolls back leaves the message waiting', async () => {
    const { registry, store, issue, sender } = await withIssue('Delete fails')
    const held = await seed(store, { from: sender, to: { kind: 'issue', id: issue.id }, status: 'stored' })
    vi.spyOn(store.issues, 'upsertIssue').mockImplementationOnce(async () => {
      throw new Error('issue tombstone failed')
    })

    await expect(registry.modules.issueSessionLifecycle.deleteIssue(issue.id)).rejects.toThrow(
      'issue tombstone failed',
    )

    expect(await statusOf(store, held)).toBe('stored')
    expect(await noticeOf(store, held)).toBeNull()
  })

  it('a message reaching an issue already deleted fails on its delivery attempt', async () => {
    const { registry, store, issue, sender } = await withIssue('Already gone')
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
    // Stored after the deletion committed: a send that raced it.
    const late = await seed(store, { from: sender, to: { kind: 'issue', id: issue.id }, status: 'stored' })

    await registry.modules.messages.sweep()
    await registry.modules.messages.flushDeliveryTriggers()

    expect(await statusOf(store, late)).toBe('failed')
    expect((await noticeOf(store, late))?.body).toContain('was deleted. Do not wait for a reply.')
  })
})
