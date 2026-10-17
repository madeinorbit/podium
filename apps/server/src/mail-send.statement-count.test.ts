/**
 * SENDING MAIL RUNS A FIXED NUMBER OF STATEMENTS [POD-6227, server-data rule
 * 8], whatever the number of sessions on the server or of messages already in
 * the target's mailbox, on both doors a send comes in by:
 * - tRPC `messages.send` (the operator's CLI over HTTP, and the web client's
 *   mail composer), from a person;
 * - the agent relay (`podium mail send` inside an agent session: the daemon
 *   relays the call as an `agentRelayRequest` frame), from a session.
 * Each to a running session and to an issue, and `issues.mailSend` (`podium
 * issue mail send`), which hands an issue's mail to the same send. The send's delivery attempt is
 * part of it (a send hands the message on before it answers); the flush of
 * queued mail is pinned in modules/messages/delivery-flush.statement-count.test.ts.
 */
import { asSessionId, firstAdminMemberId, type IssueId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { CONFIRMED_PER_SESSION } from './modules/message-feed/feed'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import type { SessionStore } from './store'
import { OPERATOR } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  quietShipping,
  type StatementPin,
} from './test-support/statement-count'

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  issueId: IssueId
  /** Runs on the issue, in its worktree: the relay's sender. */
  sender: SessionId
  /** Runs on the issue: the target of a session send. */
  target: SessionId
  others: SessionId[]
  superagent: SuperagentService
  call: ReturnType<typeof appRouter.createCaller>
  replies: Map<string, (reply: RelayResult) => void>
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Two shells on one issue, `size` other running shells, and `size` messages
 * already sent to the target before the counted send (beyond the message
 * feed's window of recent ones, which a new message then evicts from at both
 * sizes); with `issueMail`, also `size` to the issue.
 */
async function fixture(size: number, issueMail = true): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const replies = new Map<string, (reply: RelayResult) => void>()
  await attachHostDaemon(
    reg,
    (msg) => {
      if (msg.type !== 'agentRelayResult') return
      replies.get(msg.requestId)?.(msg)
      replies.delete(msg.requestId)
    },
    { repos: ['/repo'] },
  )
  await quietShipping(reg)
  const issue = await reg.issues.crud.create({ repoPath: '/repo', title: 'Mail', startNow: false })
  await reg.issues.crud.update(issue.id, { worktreePath: '/repo/.worktrees/mail' })
  const start = async (cwd: string, issueId?: IssueId): Promise<SessionId> => {
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd,
      ...(issueId ? { issueId } : {}),
    })
    await reg.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'sh',
      cwd,
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    } as never)
    return sessionId
  }
  const sender = await start('/repo/.worktrees/mail', issue.id)
  const target = await start('/repo/.worktrees/mail', issue.id)
  const others: SessionId[] = []
  for (let i = 0; i < size; i++) others.push(await start(`/other/w${i}`))
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(firstAdminMemberId(), 'admin'),
  })
  for (let i = 0; i < size + CONFIRMED_PER_SESSION; i++) {
    await call.messages.send({ to: target, body: `earlier ${i}` })
    if (issueMail && i < size) await call.messages.send({ to: issue.id, body: `earlier to the issue ${i}` })
  }
  // A shell's queue is typed one row at a time after the sends answered; let
  // it drain, or its tail falls into the counted send at the large size.
  for (let turn = 0; turn < 500; turn++) {
    await settle(reg)
    if (((await store.sync.queuedMessageCounts([target])).get(target) ?? 0) === 0) break
  }
  return { store, reg, issueId: issue.id, sender, target, others, superagent, call, replies }
}

let relayed = 0
/** One relayed call from the sender's daemon, answered by the server's reply frame. */
const relay = (f: Fixture, proc: string, input: unknown, router = 'messages'): Promise<RelayResult> => {
  const requestId = `pod6227-${relayed++}`
  return new Promise((resolve) => {
    f.replies.set(requestId, resolve)
    void f.reg.gateway.routeDaemonFrame(f.store.hostMachineId, {
      type: 'agentRelayRequest',
      requestId,
      sessionId: asSessionId(f.sender),
      router,
      proc,
      input,
    })
  })
}

const pin = (
  name: string,
  run: (f: Fixture) => Promise<unknown>,
  setup: (size: number) => Promise<Fixture> = fixture,
): StatementPin<Fixture> => ({
  name,
  setup,
  target: (f) => f.store,
  run: async (f) => {
    const sent = await run(f)
    await settle(f.reg)
    return sent
  },
  check: (result) => {
    // A relayed call answers with a result frame; tRPC answers or throws.
    const reply = result as { type?: string; ok?: boolean; error?: unknown } | undefined
    if (reply?.type === 'agentRelayResult') expect(reply.ok, JSON.stringify(reply.error)).toBe(true)
  },
  teardown: async (f) => {
    f.superagent.dispose()
    await f.reg.dispose()
    await f.store.close()
  },
})

/** Plant a read per other session in front of the mail gate, which both doors call. */
const plantPerSession = (f: Fixture): (() => void) => {
  const gate = f.reg.modules.messageGate
  const original = gate.dispatch.bind(gate)
  const spy = vi.spyOn(gate, 'dispatch').mockImplementation(async (...args) => {
    for (const other of f.others) await f.store.sessions.getSession(other)
    return await original(...args)
  })
  return () => spy.mockRestore()
}

describe('mail send: pinned statement counts at 5 and 200', () => {
  // A send to a session on an issue also queues a delivery pass for the
  // issue's held mail, which attempts each held message on its own (about 6
  // statements a message: modules/messages/service.ts `attemptPass`, POD-6229,
  // after POD-6219). These pins hold that mail out: the earlier mail went to the
  // session; the skipped pin below holds the case with the numbers.
  const sessionMailOnly = (size: number) => fixture(size, false)
  const trpcToSession = pin(
    'tRPC messages.send to a session',
    async (f) => await f.call.messages.send({ to: f.target, body: 'counted' }),
    sessionMailOnly,
  )

  // POD-6218: the earliest admin is one statement (its row) and is read once per
  // operation, and so are its settings (`meta`, `user_preferences`). tRPC to a session
  // 67 -> 62, relayed to a session 61 -> 53, to an issue 25 -> 23, mailSend 33 -> 29.
  it('over tRPC, to a running session', async () => {
    await expectConstantStatements(trpcToSession, 62)
  })

  it('tRPC pin is armed', async () => {
    await expectArmed(trpcToSession, 62, plantPerSession)
  })

  // 100 statements with 5 held issue messages, 1,272 with 200 (relay: 95 ->
  // 1,266), measured on the polaris VM for POD-6227 before POD-6219 landed.
  // Unskip, with the constant measured then, when POD-6229 reads the held
  // mail of a pass together.
  it.skip('over tRPC, to a running session whose issue holds mail (POD-6229)', async () => {
    await expectConstantStatements(
      pin('tRPC messages.send to a session, issue mail held', async (f) =>
        await f.call.messages.send({ to: f.target, body: 'counted' })),
      100,
    )
  })

  it('over tRPC, to an issue', async () => {
    await expectConstantStatements(
      pin('tRPC messages.send to an issue', async (f) => await f.call.messages.send({ to: f.issueId, body: 'counted' })),
      19,
    )
  })

  const relayToSession = pin(
    'relayed messages.send to a session',
    async (f) => await relay(f, 'send', { to: f.target, body: 'counted' }),
    sessionMailOnly,
  )

  it('through the agent relay, to a running session', async () => {
    await expectConstantStatements(relayToSession, 53)
  })

  it('relay pin is armed', async () => {
    await expectArmed(relayToSession, 53, plantPerSession)
  })

  it('through the agent relay, to its own issue', async () => {
    await expectConstantStatements(
      pin('relayed messages.send to an issue', async (f) => await relay(f, 'send', { to: f.issueId, body: 'counted' })),
      23,
    )
  })

  it('through the agent relay, issues.mailSend to its own issue', async () => {
    await expectConstantStatements(
      pin('relayed issues.mailSend', async (f) => await relay(f, 'mailSend', { id: f.issueId, body: 'counted' }, 'issues')),
      29,
    )
  })
})
