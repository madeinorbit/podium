/**
 * AGENT MAIL ON THE ONE WRITE PATH (POD-6525, design D on POD-6415).
 *
 * Driven through the REAL composed server (`makeOracle`):
 *
 *  - every mail write reaches its handler through `submit`, from each transport
 *    it is served on: `sync.submit`, the tRPC routes and the agent relay (the
 *    gate is their adapter, with the transport's tag);
 *  - a send's rows carry its `messageId` as their mutation id, the receipt is
 *    the head, and a replay answers the recorded result and sends nothing;
 *  - an address that does not exist still dead-letters, in the same shape
 *    (POD-379), now in the write;
 *  - an agent's spawn is a `session.launch` record created in the spawn's
 *    write; a replay of the request starts nothing twice;
 *  - an await's claim retirement is its own small write.
 */

import { randomUUID } from 'node:crypto'
import {
  asMutationId,
  asSessionId,
  firstAdminMemberId,
  type IssueId,
  type SessionId,
} from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePrincipalAsync } from '../../command-principal'
import { failureNoticeId } from '../../message-ids'
import {
  disposeOracles,
  makeOracle as makeBareOracle,
  type Oracle,
} from '../sessions/oracle-support'
import { SESSION_LAUNCH_KIND } from '../sessions/session-launch-effect'
import { FAMILY_COMMAND_NAMES } from '../sync-write/family-commands'
import {
  appliedReply,
  changeRows,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'
import { MAIL_COMMANDS } from './registry'
import { MAIL_AWAIT_OBSERVED, MAIL_SYNC_COMMANDS, MAIL_WRITE_PROCS } from './sync-write'

afterEach(() => disposeOracles())

interface Fixture {
  o: Oracle
  issueId: IssueId
  /** An agent running in the issue's worktree: its relay calls are an agent's. */
  agent: SessionId
}

/** The oracle, an issue with a worktree on the host, and an agent bound in it. */
async function makeFixture(): Promise<Fixture> {
  const o = await makeBareOracle()
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  const issue = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, {
    repoPath: '/r',
    title: 'Mail',
    startNow: false,
  })
  const worktree = '/r/.worktrees/issue-1-mail'
  await o.reg.issues.crud.update(o.reg.issues.reports.store.serverWriter, issue.id, {
    worktreePath: worktree,
  })
  const { sessionId } = await o.reg.modules.sessions.createSession({
    agentKind: 'shell',
    cwd: worktree,
    issueId: issue.id,
  })
  await o.reg.gateway.routeDaemonFrame(o.store.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'sh',
    cwd: worktree,
    agentKind: 'shell',
    geometry: { cols: 80, rows: 24 },
  } as never)
  return { o, issueId: issue.id as IssueId, agent: asSessionId(sessionId) }
}

let requests = 0
async function relay(f: Fixture, router: string, proc: string, input: unknown) {
  const reply = await f.o.relay({
    requestId: `mail-path-${requests++}`,
    sessionId: f.agent,
    router,
    proc,
    input,
  })
  return reply
}

/** Which commands reached the entry point, and over which transport. */
const entryCalls = (o: Oracle) => {
  const spy = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
  return () => spy.mock.calls.map(([env, , transport]) => [env.command, transport])
}

/** The fixture's issue's and agent's mail with this body, each row once. */
const messagesWithBody = async (f: Fixture, body: string) => {
  const rows = [
    ...(await f.o.store.messages.listLedger({ issueId: f.issueId, limit: 500 })),
    ...(await f.o.store.messages.listLedger({ sessionId: f.agent, limit: 500 })),
  ]
  return [...new Map(rows.filter((m) => m.body === body).map((m) => [m.id, m])).values()]
}

const newMessageId = () => `msg_${randomUUID()}`

describe('the mail writes are on the sync write entry point', () => {
  it('every write is registered, by its contract name', async () => {
    expect(MAIL_SYNC_COMMANDS).toEqual(
      MAIL_WRITE_PROCS.map((proc) => MAIL_COMMANDS[proc].contract.name),
    )
    const { o } = await makeFixture()
    const names = o.reg.modules.syncWrite.registry.names()
    for (const name of [...MAIL_SYNC_COMMANDS, MAIL_AWAIT_OBSERVED]) {
      expect(names, name).toContain(name)
      expect(FAMILY_COMMAND_NAMES, name).toContain(name)
    }
  })

  it('a send over sync.submit: its rows carry its id, the receipt is the head, a replay sends nothing', async () => {
    const f = await makeFixture()
    const id = newMessageId()
    const body = 'on the path'
    // To the agent's session: its chat record is on the feed, written in the write.
    const { result, rows } = await expectAppliedOnPath(
      f.o,
      envelope('mail.send', { to: f.agent, body, messageId: id }, id),
      { writes: true },
    )
    expect(result).toMatchObject({ id, ok: true })
    expect(rows.some((row) => row.entity === 'message')).toBe(true)
    expect(await messagesWithBody(f, body)).toHaveLength(1)
  })

  it("a mail command's message rows carry its mutationId; the hand-on after the commit is the server's own (POD-6602)", async () => {
    const f = await makeFixture()
    const id = newMessageId()
    // The operator's chat message into the agent's session: on the feed.
    appliedReply(
      await submit(f.o, envelope('mail.send', { to: f.agent, body: 'mine', messageId: id }, id)),
    )
    await f.o.reg.modules.messages.handOnOf(id)
    const rowsFor = async () =>
      (await changeRows(f.o)).filter(
        // The feed's row id names the session, the sender and the message.
        (row) => row.entity === 'message' && row.entityId.includes(id),
      )
    const sent = await rowsFor()
    // The store's row is the command's write; the hand-on that moved it on
    // after the commit wrote under the delivery service's own account.
    expect(sent[0]?.mutationId).toBe(id)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.slice(1).every((row) => row.mutationId === undefined)).toBe(true)

    // A dead letter answered in the write is the send's own write, and the
    // dismissal of its notice is the dismissing command's.
    const { sessionId: retired } = await f.o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r',
    })
    await f.o.reg.modules.sessions.setArchived(f.o.reg.modules.sessions.serverWriter, {
      sessionId: retired,
      archived: true,
    })
    const lost = newMessageId()
    appliedReply(
      await submit(
        f.o,
        envelope('mail.send', { to: retired, body: 'too late', messageId: lost }, lost),
      ),
    )
    expect((await f.o.store.messages.getMessage(lost))?.deliveryStatus).toBe('failed')
    const ofLost = (await rowsOf(f.o, asMutationId(lost))).filter(
      (row) => row.entity === 'message' && row.entityId.includes(lost),
    )
    expect(ofLost.length).toBeGreaterThan(0)
    expect(ofLost.at(-1)?.payload).toContain('failed')
    const dismissal = randomUUID()
    appliedReply(await submit(f.o, envelope('mail.dismissNotice', { id: lost }, dismissal)))
    const dismissed = (await rowsOf(f.o, asMutationId(dismissal))).filter(
      (row) => row.entity === 'message' && row.entityId.includes(lost),
    )
    expect(dismissed.length).toBeGreaterThan(0)
  })

  it('the tRPC route is an adapter: the messageId is the mutation id, and a repeat is a replay', async () => {
    const f = await makeFixture()
    // No session works it: a message to it is held.
    const lonely = await f.o.reg.issues.crud.create(f.o.reg.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'Nobody here',
      startNow: false,
    })
    const calls = entryCalls(f.o)
    const spy = vi.mocked(f.o.reg.modules.syncWrite.submitDetailed)
    const id = newMessageId()
    const first = await f.o.call.messages.send({ to: lonely.id, body: 'by route', messageId: id })
    const again = await f.o.call.messages.send({ to: lonely.id, body: 'by route', messageId: id })

    expect(calls()).toEqual([
      ['mail.send', 'trpc'],
      ['mail.send', 'trpc'],
    ])
    expect(spy.mock.calls.map(([env]) => env.mutationId)).toEqual([id, id])
    const replies = await Promise.all(spy.mock.results.map(async (r) => await r.value))
    expect(replies.map((r) => (r.reply as { replayed?: boolean }).replayed)).toEqual([false, true])
    // The write answered at its commit ("queued"); the route answers as it
    // always did, with what the hand-on after the commit found. The repeat is
    // the recorded answer, and nothing is handed on twice.
    expect(first).toMatchObject({ id, ok: true, disposition: 'held' })
    expect(again).toMatchObject({ id, ok: true, disposition: 'queued' })
    expect(
      (await f.o.store.messages.listLedger({ issueId: lonely.id as IssueId })).map((m) => m.id),
    ).toEqual([id])
  })

  it("an agent's relay send goes through the entry point as the relay", async () => {
    const f = await makeFixture()
    const calls = entryCalls(f.o)
    const r = await relay(f, 'messages', 'send', { to: f.issueId, body: 'from the agent' })
    expect(r.ok, JSON.stringify(r.error)).toBe(true)
    expect(calls()).toEqual([['mail.send', 'relay']])
  })

  it('an address that does not exist dead-letters in the same shape, in the write, with no notice (POD-379)', async () => {
    const f = await makeFixture()
    const r = await relay(f, 'messages', 'send', { to: '#9999', body: 'to nowhere' })
    expect(r.ok, JSON.stringify(r.error)).toBe(true)
    const result = r.result as { id: string }
    expect(result).toEqual({
      id: result.id,
      ok: false,
      reason: 'dead-lettered: issue no longer exists',
      disposition: 'dead_letter',
      urgency: 'fyi',
      lifecycle: 'wait',
    })
    expect((await f.o.store.messages.getMessage(result.id))?.deliveryStatus).toBe('failed')
    // The sender read the dead letter in the answer: nobody is told twice.
    expect(await f.o.store.messages.getMessage(failureNoticeId(result.id))).toBeFalsy()
  })

  it('reply, inbox and the stop hook reach the entry point from the relay', async () => {
    const f = await makeFixture()
    const sent = (await f.o.call.messages.send({
      to: f.issueId,
      body: 'please answer',
      expectResponse: true,
    })) as { id: string }
    const calls = entryCalls(f.o)

    const inbox = await relay(f, 'messages', 'inbox', {})
    expect(inbox.ok, JSON.stringify(inbox.error)).toBe(true)
    expect((inbox.result as { id: string }[]).map((m) => m.id)).toContain(sent.id)
    const reply = await relay(f, 'messages', 'reply', { id: sent.id, body: 'answered' })
    expect(reply.ok, JSON.stringify(reply.error)).toBe(true)
    expect(reply.result).toMatchObject({ ok: true, acked: true })
    const reminders = await relay(f, 'messages', 'pendingReminders', {})
    expect(reminders.ok, JSON.stringify(reminders.error)).toBe(true)

    expect(calls()).toEqual([
      ['mail.inboxConsume', 'relay'],
      ['mail.reply', 'relay'],
      ['mail.pendingReminders', 'relay'],
    ])
  })

  it('an inbox read of several unread rows marks each one inside the unit, one savepoint at a time (POD-6625)', async () => {
    // Live: `podium mail inbox` with two or more unread rows refused with
    // ParallelNestedTransactionError — the read marks were committed in
    // parallel, two sibling savepoints on the one unit.
    const f = await makeFixture()
    const sent: string[] = []
    for (const body of ['first unread', 'second unread', 'third unread']) {
      sent.push(((await f.o.call.messages.send({ to: f.issueId, body })) as { id: string }).id)
    }

    const inbox = await relay(f, 'messages', 'inbox', {})
    expect(inbox.ok, JSON.stringify(inbox.error)).toBe(true)
    const rows = inbox.result as { id: string; readAt: string | null }[]
    for (const id of sent) {
      expect(rows.find((m) => m.id === id)?.readAt, id).toBeTruthy()
      expect((await f.o.store.messages.getMessage(id))?.readAt, id).toBeTruthy()
    }
  })

  it('the other row-looping mail writes hold with several rows too: the own-issue peek and the stop hook (POD-6625)', async () => {
    const f = await makeFixture()
    const peeked: string[] = []
    for (const body of ['peek one', 'peek two']) {
      peeked.push(((await f.o.call.messages.send({ to: f.issueId, body })) as { id: string }).id)
    }
    // `inbox --issue <own issue>` consumes, through the same readInbox.
    const peek = await relay(f, 'messages', 'inbox', { issue: f.issueId })
    expect(peek.ok, JSON.stringify(peek.error)).toBe(true)
    for (const id of peeked) {
      expect((await f.o.store.messages.getMessage(id))?.readAt, id).toBeTruthy()
    }

    const asked: string[] = []
    for (const body of ['answer one', 'answer two']) {
      asked.push(
        (
          (await f.o.call.messages.send({ to: f.agent, body, expectResponse: true })) as {
            id: string
          }
        ).id,
      )
    }
    // Delivered to the agent's session, so the stop hook reminds about both.
    await relay(f, 'messages', 'inbox', {})
    const reminders = await relay(f, 'messages', 'pendingReminders', {})
    expect(reminders.ok, JSON.stringify(reminders.error)).toBe(true)
    expect((reminders.result as { id: string }[]).map((r) => r.id).sort()).toEqual(asked.sort())
  })

  it("a handler's refusal keeps its words on the relay, and is a refusal over sync.submit", async () => {
    const f = await makeFixture()
    const r = await relay(f, 'messages', 'reply', { id: 'msg_nope', body: 'x' })
    expect(r).toMatchObject({ ok: false, error: 'unknown message msg_nope' })
    expect(
      await submit(f.o, envelope('mail.reply', { id: 'msg_nope', body: 'x' }, 'm-reply-nope')),
    ).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found', message: 'unknown message msg_nope' },
    })
  })

  it('dismiss, cancel and dismissNotice reach the entry point from their routes', async () => {
    const f = await makeFixture()
    // Held for the operator: nothing past the server holds it, so a retract
    // cancels it once the request committed.
    const held = (await f.o.call.messages.send({ to: f.issueId, body: 'take it back' })) as {
      id: string
    }
    const read = (await f.o.call.messages.send({ to: f.issueId, body: 'clear me' })) as {
      id: string
    }
    const calls = entryCalls(f.o)
    const cleared = await f.o.call.messages.dismiss({ id: read.id })
    const cancelled = await f.o.call.messages.cancel({ id: held.id })
    const notice = await f.o.call.messages.dismissNotice({ id: held.id })
    expect(calls()).toEqual([
      ['mail.dismiss', 'trpc'],
      ['mail.cancel', 'trpc'],
      ['mail.dismissNotice', 'trpc'],
    ])
    expect(cleared).toMatchObject({ id: read.id, deliveryStatus: 'confirmed' })
    expect(cancelled).toMatchObject({ id: held.id })
    expect(notice).toMatchObject({ ok: true })
  })

  it("an ask stores its question in the write; the wait for the answer is the route's", async () => {
    const f = await makeFixture()
    const calls = entryCalls(f.o)
    const r = await f.o.call.sessions.ask({
      sessionId: f.agent,
      question: 'what is it?',
      timeoutSeconds: 0,
    })
    expect(r).toMatchObject({ answered: false, questionId: expect.any(String) })
    expect(calls()).toEqual([['mail.ask', 'trpc']])
    const questions = await messagesWithBody(f, 'what is it?')
    expect(questions.map((m) => m.kind)).toEqual(['question'])
  })
})

describe("an issue's agent mail is on the sync write entry point", () => {
  it('mailSend, mailInbox and mailClaim reach it from their routes and the relay', async () => {
    const f = await makeFixture()
    const lonely = await f.o.reg.issues.crud.create(f.o.reg.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'Nobody here',
      startNow: false,
    })
    const calls = entryCalls(f.o)
    const sent = (await f.o.call.issues.mailSend({ id: lonely.id, body: 'for the box' })) as {
      id: string
    }
    // The route answers with the hand-on after the commit, as it did inline.
    expect(sent).toMatchObject({ ok: true, disposition: 'held', body: 'for the box' })
    await vi.waitFor(async () =>
      expect(
        ((await f.o.call.issues.mailInbox({ id: lonely.id })) as { id: string }[]).map((m) => m.id),
      ).toContain(sent.id),
    )
    const claimed = await f.o.call.issues.mailClaim({ messageId: sent.id })
    expect(claimed).toMatchObject({ claimed: true })
    const relayed = await relay(f, 'issues', 'mailSend', { id: f.issueId, body: 'from inside' })
    expect(relayed.ok, JSON.stringify(relayed.error)).toBe(true)

    const commands = calls()
    expect(commands[0]).toEqual(['issues.mailSend', 'trpc'])
    expect(commands).toContainEqual(['issues.mailInbox', 'trpc'])
    expect(commands).toContainEqual(['issues.mailClaim', 'trpc'])
    expect(commands.at(-1)).toEqual(['issues.mailSend', 'relay'])
  })
})

describe("an agent's spawn is a session.launch record", () => {
  const launchesOn = async (o: Oracle, sessionId: string) =>
    (await o.store.sync.changesSince(0))
      .filter((row) => row.entity === 'effect')
      .map((row) => row.entityId)
      .filter((id, i, all) => all.indexOf(id) === i)
      .map(async (id) => await o.store.effects.get(id))

  it('the route answers the old shape once the record settled; a replay starts nothing twice', async () => {
    const f = await makeFixture()
    const calls = entryCalls(f.o)
    const requestId = randomUUID()
    const input = { issue: f.issueId, harness: 'shell', prompt: 'do the thing', requestId }

    const first = (await f.o.call.messages.spawnAgent(input)) as Record<string, unknown>
    const again = (await f.o.call.messages.spawnAgent(input)) as Record<string, unknown>

    expect(calls()).toEqual([
      ['mail.spawnAgent', 'trpc'],
      ['mail.spawnAgent', 'trpc'],
    ])
    expect(first).toMatchObject({
      ok: true,
      issueId: f.issueId,
      harness: 'shell',
      sessionId: expect.any(String),
      agentId: expect.any(String),
    })
    expect(first).not.toHaveProperty('effectId')
    expect(again.sessionId).toBe(first.sessionId)
    const records = (await Promise.all(await launchesOn(f.o, String(first.sessionId)))).filter(
      (record) => record?.kind === SESSION_LAUNCH_KIND,
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      status: 'succeeded',
      target: { kind: 'session', id: first.sessionId },
    })
    const child = await f.o.reg.modules.sessions.sessionById(first.sessionId as SessionId)
    expect(child).toMatchObject({ issueId: f.issueId, spawnedBy: 'user' })
  })

  it('over sync.submit the record is created in the write, under its provenance', async () => {
    const f = await makeFixture()
    const mutationId = randomUUID()
    const reply = appliedReply(
      await submit(
        f.o,
        envelope(
          'mail.spawnAgent',
          { issue: f.issueId, harness: 'shell', prompt: 'p', requestId: mutationId },
          mutationId,
        ),
      ),
    )
    const result = reply.result as { effectId: string; sessionId: string }
    const rows = await rowsOf(f.o, asMutationId(mutationId))
    expect(rows.some((row) => row.entity === 'effect' && row.entityId === result.effectId)).toBe(
      true,
    )
    const replay = appliedReply(
      await submit(
        f.o,
        envelope(
          'mail.spawnAgent',
          { issue: f.issueId, harness: 'shell', prompt: 'p', requestId: mutationId },
          mutationId,
        ),
      ),
    )
    expect(replay.replayed).toBe(true)
    expect(replay.result).toEqual(reply.result)
  })

  it('nobody creates a spawn record through effects.create', async () => {
    const f = await makeFixture()
    const reply = await submit(
      f.o,
      envelope(
        'effects.create',
        {
          id: `eff_${randomUUID()}`,
          kind: SESSION_LAUNCH_KIND,
          target: { kind: 'session', id: randomUUID() },
          input: {
            agentKind: 'shell',
            cwd: '/r',
            spawnAgent: { ownerUserId: firstAdminMemberId(), spawnedBy: 'session:someone' },
          },
        },
        'm-forged-spawn',
      ),
    )
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'invalid' } })
  })

  it("an agent's spawn onto another issue is refused at the target, in the old words", async () => {
    const f = await makeFixture()
    const other = await f.o.reg.issues.crud.create(f.o.reg.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'Other',
      startNow: false,
    })
    const r = await relay(f, 'messages', 'spawnAgent', {
      issue: other.id,
      harness: 'shell',
      prompt: 'cross the boundary',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/outside your subtree/)
  })
})

describe("an await's claim retirement is its own write", () => {
  it('only the parent may retire it; the await of a working child retires nothing', async () => {
    const f = await makeFixture()
    const spawned = await relay(f, 'messages', 'spawnAgent', {
      issue: f.issueId,
      harness: 'shell',
      prompt: 'child work',
    })
    expect(spawned.ok, JSON.stringify(spawned.error)).toBe(true)
    const child = (spawned.result as { sessionId: string }).sessionId
    const calls = entryCalls(f.o)
    const awaited = await relay(f, 'messages', 'awaitAgent', {
      sessionId: child,
      timeoutSeconds: 0,
    })
    expect(awaited.result).toMatchObject({ result: 'working' })
    expect(calls()).toEqual([])

    const retire = vi.spyOn(f.o.reg.modules.messageGate, 'retireParentNudge')
    const principalOf = async (sessionId: SessionId) =>
      await resolvePrincipalAsync(await f.o.reg.modules.sessions.capabilityForSession(sessionId), {
        parentSessionOf: async () => undefined,
      })
    const asParent = await f.o.reg.modules.syncWrite.submit(
      envelope(MAIL_AWAIT_OBSERVED, { sessionId: child }, 'm-observed'),
      await principalOf(f.agent),
      'relay',
    )
    expect(asParent).toMatchObject({ outcome: 'applied' })
    expect(retire).toHaveBeenCalledWith(`sessionparentnudge:phase-reported:${child}`, f.agent)

    const stranger = await f.o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/issue-1-mail',
    })
    const asStranger = await f.o.reg.modules.syncWrite.submit(
      envelope(MAIL_AWAIT_OBSERVED, { sessionId: child }, 'm-observed-stranger'),
      await principalOf(asSessionId(stranger.sessionId)),
      'relay',
    )
    expect(asStranger).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(retire).toHaveBeenCalledTimes(1)
  })
})
