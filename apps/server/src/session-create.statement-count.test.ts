/**
 * CREATING A SESSION RUNS A FIXED NUMBER OF STATEMENTS [POD-6227, server-data
 * rule 8], whatever the number of sessions, issues and machines already on
 * the server: in process (`SessionsModule.createSession`, what every server
 * path ends in) and over tRPC (`sessions.create`, the client's door, with its
 * command envelope, idempotency and machine-use reads in front).
 *
 * Placement reads the machine list and the repo registry, both whole (one
 * read each; the registry is cached), and a new session gets its ref from a
 * per-repo or per-issue counter, never from a scan of the sessions it joins.
 *
 * Since POD-2156 an agent started in a known repo with no issue gets its own
 * draft task, so the tRPC create also creates an issue and records its
 * `issue.created` feed event. The feed keeps the newest FEED_WINDOW events and
 * each new one evicts the oldest once it is full, so the fixture fills the
 * window at every size: both sizes then pay the same one eviction.
 */
import { asMachineId, firstAdminMemberId, type IssueId, type UserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { FEED_WINDOW } from './modules/issue-events/feed'
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

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  owner: UserId
  issueId: IssueId
  others: string[]
  superagent: SuperagentService
  call: ReturnType<typeof appRouter.createCaller>
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** `size` running sessions, `size` issues and `size` other machines (offline). */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
  await quietShipping(reg)
  const owner = firstAdminMemberId()
  for (let i = 0; i < size; i++) {
    await store.machines.upsertMachine({
      id: asMachineId(`mach_other_${i}`),
      name: `Other ${i}`,
      hostname: `other-${i}`,
      tokenHash: `token-${i}`,
      ownerUserId: owner,
      assignment: { server: false, agentExecution: true },
    })
  }
  let issueId: IssueId | undefined
  const others: string[] = []
  for (let i = 0; i < size; i++) {
    // An explicit parent: create would otherwise probe the repo for its base
    // branch (POD-2065), which the test daemon never answers (3 s per issue).
    const issue = await reg.issues.crud.create({
      repoPath: '/repo',
      title: `Issue ${i}`,
      startNow: false,
      parentBranch: 'main',
    })
    issueId ??= issue.id
    const cwd = `/repo/w${i}`
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd, issueId: issue.id })
    await reg.gateway.routeDaemonFrame(store.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex',
      cwd,
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
    } as never)
    others.push(sessionId)
  }
  // Fill the issue-event feed window (see the header) with stage changes of
  // the first issue, one feed event each: it starts in backlog, so each step
  // alternates planning and backlog and always changes the stage.
  for (let n = 0; n < FEED_WINDOW - size; n++) {
    await reg.issues.crud.update(issueId!, { stage: n % 2 === 0 ? 'planning' : 'backlog' })
  }
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(owner, 'admin'),
  })
  await settle(reg)
  return { store, reg, owner, issueId: issueId!, others, superagent, call }
}

const pin = (name: string, run: (f: Fixture) => Promise<{ sessionId: string }>): StatementPin<Fixture> => ({
  name,
  setup: fixture,
  target: (f) => f.store,
  run: async (f) => {
    const created = await run(f)
    await settle(f.reg)
    return created
  },
  check: async (result, f) => {
    const { sessionId } = result as { sessionId: string }
    expect(await f.store.sessions.getSession(sessionId as never)).toBeDefined()
  },
  teardown: async (f) => {
    f.superagent.dispose()
    await f.reg.dispose()
    await f.store.close()
  },
})

/** Plant a read per existing session of the fixture where creation reads the machine list. */
const plantPerSession = (f: Fixture): (() => void) => {
  const machines = f.reg.modules.machines
  const original = machines.listMachines.bind(machines)
  const spy = vi.spyOn(machines, 'listMachines').mockImplementation(async (...args) => {
    for (const id of f.others) await f.store.sessions.getSession(id as never)
    return await original(...args)
  })
  return () => spy.mockRestore()
}

describe('session create: pinned statement counts at 5 and 200', () => {
  const draft = pin('createSession (draft, no issue)', async (f) =>
    await f.reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/repo/new' }))

  // POD-6218: the earliest admin is one statement (its row) and is read once per
  // operation, and so are its settings (`meta`, `user_preferences`). Draft 39 -> 35,
  // on an issue 40 -> 37, over tRPC 38 -> 29.
  // On dev/mw (POD-6250): draft 35 -> 34, the cwd's worktree owners are read once
  // with their machine (dc09092a07); over tRPC 29 -> 51, the draft task the
  // create now makes (5677f213d2, POD-2156): the issue, its ref letters, event,
  // projection, its feed window eviction and their visibility reads.
  // On integrate/pdm-107-multi-user the three ran 30, 33 and 50 before POD-6290
  // (the pins had not followed). POD-6290 adds the starter's personal record:
  // on an issue one read of their user-state row (the record already exists),
  // over tRPC the draft task's creation record, one read, one upsert and its
  // two feed rows, plus that read at the spawn: 30, 34 and 56.
  it('in process, a draft session in a repo', async () => {
    await expectConstantStatements(draft, 30)
  })

  it('in-process pin is armed', async () => {
    await expectArmed(draft, 30, plantPerSession)
  })

  it('in process, a session on an issue', async () => {
    await expectConstantStatements(
      pin('createSession (on an issue)', async (f) =>
        await f.reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/repo/w0', issueId: f.issueId })),
      34,
    )
  })

  const trpc = pin('tRPC sessions.create', async (f) =>
    await f.call.sessions.create({ agentKind: 'codex', cwd: '/repo/new' }))

  it('over tRPC', async () => {
    await expectConstantStatements(trpc, 56)
  })

  it('tRPC pin is armed', async () => {
    await expectArmed(trpc, 56, plantPerSession)
  })
})
