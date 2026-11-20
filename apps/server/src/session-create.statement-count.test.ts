// POD-6789: two model-table builds replace the stored-copy comparison; source queue and registry writes publish atomically. Pins measured at both fixture sizes on the agents VM.
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
import type { ControlSend } from './gateway/daemon-ports'
import { FEED_WINDOW } from './modules/issue-events/feed'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import type { SessionStore } from './store'
import { OPERATOR } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { testStoreEngine } from './test-support/pg-test-database'
import { expectConstantRoundTrips } from './test-support/round-trip-count'
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
/**
 * A fake daemon that answers the connect scan as a real one does: each root it was asked
 * about is a repository. Unanswered, the scan waits out its 10 s timeout and writes the
 * root's checkout then, inside the measured run once the 200-row fixture takes longer.
 */
function answeringRepoScans(reg: SessionRegistry): ControlSend {
  return (message) => {
    if (message.type !== 'scanReposRequest') return
    void reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'scanReposResult',
      requestId: message.requestId,
      repositories: message.roots.map((path) => ({ path, kind: 'repository', worktrees: [] })),
      diagnostics: [],
    })
  }
}

async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, answeringRepoScans(reg), { repos: ['/repo'] })
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
    const issue = await reg.issues.crud.create(reg.issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: `Issue ${i}`,
      startNow: false,
      parentBranch: 'main',
    })
    issueId ??= issue.id
    const cwd = `/repo/w${i}`
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd,
      issueId: issue.id,
    })
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
    await reg.issues.crud.update(reg.issues.reports.store.serverWriter, issueId!, {
      stage: n % 2 === 0 ? 'planning' : 'backlog',
    })
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

const pin = (
  name: string,
  run: (f: Fixture) => Promise<{ sessionId: string }>,
): StatementPin<Fixture> => ({
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
    const row = await f.store.sessions.getSession(sessionId as never)
    expect(row).toMatchObject({ ownerUserId: f.owner, agentKind: 'codex' })
    expect(['/repo/new', '/repo/w0']).toContain(row?.cwd)
    // No selected/default credential: custody permits the machine's own login.
    expect(row?.credentialId ?? null).toBeNull()
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
  const draft = pin(
    'createSession (draft, no issue)',
    async (f) =>
      await f.reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/repo/new' }),
  )

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
  // POD-6301's native-login opt-in lookup adds one to each (31, 35, 57 on
  // settled integration 4bd324eea2). POD-6303 validates an active owner at
  // start and immediately before spawn: two user reads in process, one extra
  // over tRPC where the principal's read is already memoized. 33, 37, 58;
  // measured at both sizes, with the per-session loop controls retained below.
  // POD-6398: over tRPC 51 -> 82, the route is an adapter onto a `session.launch`
  // effect record: the entry point's dedup read and record, the record's insert,
  // claim and settlement, their change rows and feed-visibility audience reads,
  // the waiter's reads of the record, and the writer's row for the act-time
  // check. Constant at 5 and 200 sessions, as before.
  // The combined tRPC pin carries both deltas (51 + 7 + 31 = 89);
  // this merge resolution does not remeasure it.
  it('in process, a draft session in a repo', async () => {
    // POD-6920 derived capture had put this at 41; the current resolver is measured below.
    // Credential resolution replaced the old accounts environment lookup (POD-6890).
    // The no-credential path no longer reads accounts, but still checks native opt-in.
    const counts = await expectConstantStatements(draft, 40)
    for (const tally of [counts.small, counts.large]) {
      expect([...tally.byQuery.keys()].some((key) => /from "accounts"/.test(key))).toBe(false)
      expect(
        [...tally.byQuery]
          .filter(([key]) => /from "native_login_opt_ins"/.test(key))
          .reduce((n, [, count]) => n + count, 0),
      ).toBe(1)
    }
  })

  it('in-process pin is armed', async () => {
    await expectArmed(draft, 40, plantPerSession)
  })

  // ROUND TRIPS ON HOSTED POSTGRES [POD-6992, POD-6958 design 2.11]: the driver calls that
  // wait for the server, counted by the Postgres driver's pipelining (BEGIN with the first
  // statement or with the workspace lock, one per statement, one per COMMIT). About 2.6 ms
  // each on hosted Postgres; docs/measurements/pod-6958-hosted-round-trips.md.
  it('in process, a draft session in a repo: round trips', async () => {
    await expectConstantRoundTrips(draft, 48)
  }, 60_000)

  it('in process, a session on an issue', async () => {
    await expectConstantStatements(
      pin(
        'createSession (on an issue)',
        async (f) =>
          await f.reg.modules.sessions.createSession({
            agentKind: 'codex',
            cwd: '/repo/w0',
            issueId: f.issueId,
          }),
      ),
      // POD-6890: the credential resolver removes the old accounts environment read: 46 -> 45.
      45,
    )
  })

  const trpc = pin(
    'tRPC sessions.create',
    async (f) => await f.call.sessions.create({ agentKind: 'codex', cwd: '/repo/new' }),
  )

  // SQLite only (POD-6994): on Postgres the feed publications that follow the create's seven
  // commits are coalesced per microtask, so how many there are depends on I/O timing (a
  // commit that lands alone is published alone). Their retention-floor and record reads
  // vary from run to run: 106 to 110 statements and 144 to 146 round trips seen, at either
  // size. On SQLite the commits coalesce the same way every run, and the round-trip pin
  // there is the Postgres driver's model of the same calls.
  const onSqliteFeedTiming = it.runIf(testStoreEngine() !== 'pg')

  onSqliteFeedTiming('over tRPC', async () => {
    // POD-6890: the same removed accounts environment read applies over tRPC: 106 -> 105.
    await expectConstantStatements(trpc, 105)
  })

  onSqliteFeedTiming('tRPC pin is armed', async () => {
    await expectArmed(trpc, 105, plantPerSession)
  })

  onSqliteFeedTiming(
    'over tRPC: round trips (POD-6992)',
    async () => {
      // The session's activity publication runs on a timer the create starts; at 200 rows
      // the create outlasts its delay, and its root read lands inside the window.
      await expectConstantRoundTrips(trpc, 143, undefined, /idx_sessions_pending_activity/)
    },
    60_000,
  )
})
