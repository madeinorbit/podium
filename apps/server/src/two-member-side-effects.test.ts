import { fixtureWriteScope } from '@podium/sync/testing'
/**
 * ONE MEMBER'S ACT ON A SHARED TASK SPENDS NOTHING OF ANOTHER MEMBER'S
 * (POD-6368; design §2.3, MU-21 in §6). Sessions are private, and input into a
 * session counts as driving it. So when Bob acts on Alice's task:
 *
 * - the steward types no nudge into Alice's session (a child of her task
 *   closed or moved to review, or her task's blocker closed). Alice still sees
 *   what happened: the steward's comment on her task stays;
 * - an issue subscription of Bob's nudges only Bob's sessions;
 * - archiving the task archives only Bob's sessions;
 * - a session's unread-mail pointer counts only mail that session would have
 *   been handed (POD-6296's rule).
 *
 * Every test makes its own tasks and sessions, so the shared fixture rows stay
 * as the other two-member files expect them. Alice's own acts keep today's
 * behaviour, and each test shows that too.
 */

import { asIssueId, asThreadId, type IssueId, type SessionId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedMessage } from './test-support/seed-message'
import {
  MEMBERS,
  type MemberName,
  REPO_PATH,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance

beforeAll(async () => {
  f = await startTwoMemberInstance()
  const settings = f.handle.registry.sessionStore.settings
  await settings.setSettings({ ...(await settings.getSettings()), steward: { enabled: true } })
  // The janitor's first poll seeds the cursor past history; later polls read on.
  await f.handle.registry.runStewardTick()
  // Sign both in once here, so no test pays for the password checks.
  await f.as('alice')
  await f.as('bob')
}, 120_000)
afterAll(async () => {
  await f?.close()
})

interface Wire {
  id: string
  seq: number
}

const trpc = async (name: MemberName) => (await f.as(name)).trpc

/** A fresh task of `owner`'s, created through their own login. */
async function taskOf(owner: MemberName, title: string, parentId?: string): Promise<Wire> {
  return (await (
    await trpc(owner)
  ).issues.create.mutate({
    repoPath: REPO_PATH,
    title,
    startNow: false,
    ...(parentId ? { parentId } : {}),
  } as never)) as Wire
}

/** A live agent session of `owner` on `issueId`, started the way `sessions.create` starts one. */
async function sessionOn(owner: 'alice' | 'bob', issueId: string, title: string) {
  const sessions = f.handle.registry.modules.sessions
  const sessionId = (
    await sessions.createSession({
      ownerUserId: MEMBERS[owner].id,
      agentKind: 'claude-code',
      cwd: `/wt/${owner}-${title}`,
      title,
      machineId: f.machines[owner],
      issueId: asIssueId(issueId),
      binding: { principal: { kind: 'user', userId: MEMBERS[owner].id } },
    })
  ).sessionId
  return sessionId
}

/** Run the steward until it has read every event so far. */
async function stewardCatchesUp(): Promise<void> {
  const store = f.handle.registry.sessionStore
  await store.events.settleGroupedAppends()
  for (let i = 0; i < 50; i++) {
    const head = await store.events.maxEventId()
    await f.handle.registry.runStewardTick()
    if (Number((await store.events.getStewardState('cursor')) ?? 0) >= head) return
  }
  throw new Error('the steward did not catch up')
}

/** The steward's notices addressed to a session. */
async function stewardNotices(sessionId: SessionId): Promise<string[]> {
  return (
    await f.handle.registry.sessionStore.messages.listMessagesFor({
      kind: 'session',
      id: sessionId,
    })
  )
    .filter((m) => m.fromKind === 'system')
    .map((m) => m.body)
}

/** The steward's comments on a task. */
async function stewardComments(issueId: string): Promise<string[]> {
  return (await f.handle.registry.issues.reports.comments(asIssueId(issueId)))
    .filter((c) => c.author === 'steward')
    .map((c) => c.body)
}

describe('MU-21 (continued): Bob’s act on Alice’s task types no steward nudge into her session', {
  timeout: 90_000,
}, () => {
  it('Bob closing a child of Alice’s task nudges Alice’s session nothing; her own close still does', async () => {
    const parent = await taskOf('alice', 'Alice moraine map')
    const alices = await sessionOn('alice', parent.id, 'alice-moraine')
    const bobsChild = await taskOf('bob', 'Bob moraine samples', parent.id)
    const alicesChild = await taskOf('alice', 'Alice moraine photos', parent.id)

    await (await trpc('bob')).issues.close.mutate({ id: bobsChild.id } as never)
    await stewardCatchesUp()
    expect(await stewardNotices(alices)).toEqual([])
    // Alice still sees it: the steward's comment on her task.
    expect((await stewardComments(parent.id)).join('\n')).toContain(`#${bobsChild.seq}`)

    await (await trpc('alice')).issues.close.mutate({ id: alicesChild.id } as never)
    await stewardCatchesUp()
    expect((await stewardNotices(alices)).join('\n')).toContain(`#${alicesChild.seq}`)
  })

  it('Bob moving a child of Alice’s task to review nudges Alice’s session nothing; her own move still does', async () => {
    const parent = await taskOf('alice', 'Alice esker map')
    const alices = await sessionOn('alice', parent.id, 'alice-esker-map')
    const bobsChild = await taskOf('bob', 'Bob esker samples', parent.id)
    const alicesChild = await taskOf('alice', 'Alice esker photos', parent.id)

    await (await trpc('bob')).issues.update.mutate({
      id: bobsChild.id,
      patch: { stage: 'review' },
    } as never)
    await stewardCatchesUp()
    expect(await stewardNotices(alices)).toEqual([])
    expect((await stewardComments(parent.id)).join('\n')).toContain(`#${bobsChild.seq}`)

    await (await trpc('alice')).issues.update.mutate({
      id: alicesChild.id,
      patch: { stage: 'review' },
    } as never)
    await stewardCatchesUp()
    expect((await stewardNotices(alices)).join('\n')).toContain(`#${alicesChild.seq}`)
  })

  it('Bob’s agent closing the blocker of Alice’s task nudges Alice’s session nothing; Alice closing one still does', async () => {
    const blocked = await taskOf('alice', 'Alice drumlin map')
    const alices = await sessionOn('alice', blocked.id, 'alice-drumlin-map')
    const bobsBlocker = await taskOf('bob', 'Bob drumlin survey')
    const bobsAgent = await sessionOn('bob', bobsBlocker.id, 'bob-drumlin-survey')
    await (await trpc('alice')).issues.depAdd.mutate({
      fromId: blocked.id,
      toId: bobsBlocker.id,
    } as never)

    await f.agent(bobsAgent, { machineId: f.machines.bob }).cli(['close', String(bobsBlocker.seq)])
    await stewardCatchesUp()
    expect(await stewardNotices(alices)).toEqual([])
    expect((await stewardComments(blocked.id)).join('\n')).toContain(
      `Unblocked by #${bobsBlocker.seq}:`,
    )

    const secondBlocked = await taskOf('alice', 'Alice drumlin atlas')
    const alicesSecond = await sessionOn('alice', secondBlocked.id, 'alice-drumlin-atlas')
    const alicesBlocker = await taskOf('alice', 'Alice drumlin legend')
    await (await trpc('alice')).issues.depAdd.mutate({
      fromId: secondBlocked.id,
      toId: alicesBlocker.id,
    } as never)
    await (await trpc('alice')).issues.close.mutate({ id: alicesBlocker.id } as never)
    await stewardCatchesUp()
    expect((await stewardNotices(alicesSecond)).join('\n')).toContain(`#${alicesBlocker.seq}`)
  })
})

describe('an issue subscription nudges only its own human’s sessions', { timeout: 90_000 }, () => {
  it('Bob’s subscription on his task nudges Bob’s session on it, not Alice’s', async () => {
    const task = await taskOf('bob', 'Bob kettle survey')
    const watched = await taskOf('bob', 'Bob kettle samples')
    const bobs = await sessionOn('bob', task.id, 'bob-kettle')
    const alices = await sessionOn('alice', task.id, 'alice-kettle')
    await (await trpc('bob')).issues.subscriptionAdd.mutate({
      subscriber: { kind: 'issue', id: task.id },
      event: 'issue.stage_changed',
      source: { kind: 'issue', ref: watched.id },
    } as never)

    await (await trpc('bob')).issues.update.mutate({
      id: watched.id,
      patch: { stage: 'planning' },
    } as never)
    await stewardCatchesUp()
    expect((await stewardNotices(bobs)).length).toBeGreaterThan(0)
    expect(await stewardNotices(alices)).toEqual([])
  })
})

describe('archiving a shared task archives only the archiver’s own sessions', () => {
  const archived = async (sessionId: SessionId) =>
    (await f.handle.registry.sessionStore.sessions.getSessions([sessionId])).get(sessionId)
      ?.archived

  it('Bob archiving Alice’s task leaves Alice’s sessions as they were and archives his own', async () => {
    const task = await taskOf('alice', 'Alice cirque map')
    const alices = await sessionOn('alice', task.id, 'alice-cirque')
    const bobs = await sessionOn('bob', task.id, 'bob-cirque')

    await (await trpc('bob')).issues.archive.mutate({ id: task.id } as never)
    expect(await archived(bobs)).toBe(true)
    expect(await archived(alices)).toBe(false)
    // Alice's session still shows the task, now archived.
    expect((await f.handle.registry.issues.reports.getMeta(task.id))?.archived).toBe(true)
  })

  it('the read-gated sweep acts for the assignee: Alice’s read archives her task and her session, not Bob’s', async () => {
    const task = await taskOf('alice', 'Alice nunatak atlas')
    const alices = await sessionOn('alice', task.id, 'alice-nunatak-atlas')
    const bobs = await sessionOn('bob', task.id, 'bob-nunatak-atlas')
    await (await trpc('alice')).issues.close.mutate({ id: task.id } as never)
    // Alice read it after its last activity; ten days later it is due.
    await f.handle.registry.sessionStore.issues.setIssueUserState(
      fixtureWriteScope(),
      MEMBERS.alice.id,
      asIssueId(task.id),
      {
        readAt: new Date(Date.now() + 1000).toISOString(),
      },
    )
    const later = Date.now() + 10 * 86_400_000
    const swept = await f.handle.registry.issues.attention.sweepAutoArchive(later)
    expect(swept.map((w) => w.id)).toContain(task.id)
    expect(await archived(alices)).toBe(true)
    expect(await archived(bobs)).toBe(false)
  })

  it('Alice archiving her own task archives her sessions on it, as today', async () => {
    const task = await taskOf('alice', 'Alice arete map')
    const alices = await sessionOn('alice', task.id, 'alice-arete')
    await (await trpc('alice')).issues.archive.mutate({ id: task.id } as never)
    expect(await archived(alices)).toBe(true)
  })
})

describe('a session’s unread-mail pointer counts only mail that would reach it', () => {
  const pending = async (issueId: string, sessionId: SessionId) =>
    (
      await f.handle.registry.issues.commentsMail.mailPending(asIssueId(issueId) as IssueId, {
        sessionId,
      })
    ).unread

  /** A row in the task's mailbox not yet handed to anyone, as a held or
   *  still-queued one is, sent by `from` for `onBehalfOf` (null: system mail). */
  async function pendingMail(
    task: Wire,
    from: SessionId | null,
    onBehalfOf: string | null,
    body: string,
  ): Promise<void> {
    await seedMessage(f.handle.registry.sessionStore.messages, {
      id: `msg_${body}`,
      threadId: asThreadId(`thr_${body}`),
      inReplyTo: null,
      fromKind: from ? 'agent' : 'system',
      fromSession: from,
      fromIssue: from ? asIssueId(task.id) : null,
      toKind: 'issue',
      toId: task.id,
      kind: 'message',
      urgency: 'fyi',
      lifecycle: 'wait',
      body,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      deliveredTo: null,
      readAt: null,
      injectedAt: null,
      deadLetteredAt: null,
      ackedBy: null,
      hop: 0,
      clampedFrom: null,
      remindedAt: null,
      factKey: null,
      factTarget: null,
      expectsResponse: false,
      delegationRef: null,
      attribution: from
        ? { actor: { kind: 'agent', id: from }, onBehalfOf }
        : { actor: { kind: 'system', job: 'steward' }, onBehalfOf: null },
    } as never)
  }

  it('Alice’s agent’s mail to her task, held for Bob’s session, is not on that session’s pointer', async () => {
    const task = await taskOf('alice', 'Alice tarn map')
    const alices = await sessionOn('alice', task.id, 'alice-tarn-map')
    const bobs = await sessionOn('bob', task.id, 'bob-tarn-map')

    const sent = await f
      .agent(alices, { machineId: f.machines.alice })
      .cli(['mail', 'send', String(task.seq), '--body', 'tarn-mail-from-alice'])
    expect(sent).toContain('HELD')
    expect(await pending(task.id, bobs)).toBe(0)
  })

  it('Bob’s session counts its own human’s and system mail; Alice’s only once it subscribed to the task’s mail', async () => {
    const task = await taskOf('alice', 'Alice pingo map')
    const alices = await sessionOn('alice', task.id, 'alice-pingo-map')
    const watching = await sessionOn('bob', task.id, 'bob-pingo-watch')
    const other = await sessionOn('bob', task.id, 'bob-pingo-other')
    await f
      .agent(watching, { machineId: f.machines.bob })
      .cli(['subscription', 'add', 'issue.mail', '--source-kind', 'issue', '--source-ref', task.id])
    const stamp = Date.now()
    await pendingMail(task, alices, MEMBERS.alice.id, `pingo-alice-${stamp}`)
    await pendingMail(task, other, MEMBERS.bob.id, `pingo-bob-${stamp}`)
    await pendingMail(task, null, null, `pingo-system-${stamp}`)

    // Bob's unsubscribed session: his own human's mail and the system's.
    expect(await pending(task.id, other)).toBe(1)
    // Bob's subscribed session: all three.
    expect(await pending(task.id, watching)).toBe(3)
    // Alice's session: her own human's mail (a peer session's), Bob's is not hers.
    expect(await pending(task.id, alices)).toBe(1)
  })
})
