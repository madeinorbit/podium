/**
 * THE TWO-MEMBER INSTANCE (POD-6282): one real server with Alice, Bob and Carol,
 * so a test can prove who may see and do what (design §6, the acceptance matrix).
 *
 * WHO OWNS WHAT, after `await startTwoMemberInstance()`:
 *
 * | Member | Role            | Machine (custody)  | Task          | Sessions                                    |
 * |--------|-----------------|--------------------|---------------|---------------------------------------------|
 * | Alice  | admin (earliest)| `machine-alice`    | `aliceTask`   | `aliceSession` on machine-alice, aliceTask  |
 * | Bob    | member          | `machine-bob`      | `bobTask`     | `bobSession` on machine-bob, bobTask;       |
 * |        |                 |                    |               | `bobOnAliceTask` on machine-bob, aliceTask  |
 * | Carol  | member, disabled| none               | none          | none                                        |
 *
 * - Custody is the `grants` edge `verb='manage', custody=1` that
 *   `machines.upsertMachine({ ownerUserId })` writes. Nobody holds a `use` grant
 *   on anyone else's machine.
 * - Both machines report the repo `/repo` and have a fake daemon attached, so
 *   sessions can be placed on them and their agents can relay.
 * - Every session is an agent session (`claude`), started the way `sessions.create`
 *   starts one for a signed-in member (owner and binding principal = the starter).
 *   `bobOnAliceTask` is Bob's by the design (§2.3) although it sits on Alice's task.
 *   TODAY `dev/mw` records it as ALICE's (an issue-owned session inherits the
 *   issue owner, `session-start.ts`; design gap 3, POD-6283): only its
 *   `createdBy.onBehalfOf` says Bob. `two-member-gaps.test.ts` pins that.
 * - Carol has a password, but she is disabled, so she cannot sign in.
 * - Alice is `firstAdminMemberId()`: the account an upgraded instance starts with.
 *
 * HOW TO ACT AS SOMEONE (each goes through the production transport, with the
 * member's own login cookie, never a hand-built principal):
 *
 * - `as(member).trpc` is an HTTP tRPC client for `/trpc`; `as(member).fetch`
 *   any other HTTP route.
 * - `as(member).feed()` opens the real `/client` WebSocket. `bootstrap()` reads
 *   the member's snapshot over `sync.changesSince`; `deltas` collects the
 *   `feedDelta` frames pushed afterwards.
 * - `agent(sessionId)` acts as that session's agent over the daemon relay:
 *   `cli([...])` runs `podium issue …`, `mcp(tool, input)` calls an MCP issue tool.
 * - `legacyDeviceFeed()` reads the feed as the device-grade principal
 *   (`device:shared-instance-password`, design gap 7).
 *
 * Use one instance per test file (`beforeAll`/`afterAll`): booting a server
 * costs about a second. Tests that mutate shared rows should create their own.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type IssueTrpc, makeRelayIssueClient } from '@podium/issue-client'
import {
  asMachineId,
  asUserId,
  firstAdminMemberId,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import {
  CLIENT_WIRE_VERSION,
  type FeedDeltaMessage,
  type ServerMessage,
  type SyncChangesSinceResult,
} from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { hashPassword } from '@podium/runtime/auth-store'
import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client'
import WebSocket from 'ws'
import { runIssueCli } from '../../../cli/src/issue-cli'
import { createAgentRelayHub, startAgentRelayServer } from '../../../daemon/src/agent-relay'
import { IssueToolProvider } from '../issue-mcp'
import { noJanitorWorkerForTests } from '../janitor-host'
import type { AppRouter } from '../router'
import { startServer } from '../server'
import { attachDaemonWithInventory } from './daemon-inventory'

export type MemberName = 'alice' | 'bob' | 'carol'

export interface FixtureMember {
  readonly name: MemberName
  readonly displayName: string
  readonly id: UserId
  readonly email: string
  readonly password: string
  readonly role: 'admin' | 'member'
}

export const MEMBERS: Readonly<Record<MemberName, FixtureMember>> = {
  alice: {
    name: 'alice',
    displayName: 'Alice',
    id: firstAdminMemberId(),
    email: 'alice@example.com',
    password: 'alice-fixture-password',
    role: 'admin',
  },
  bob: {
    name: 'bob',
    displayName: 'Bob',
    id: asUserId('mem_fixture_bob'),
    email: 'bob@example.com',
    password: 'bob-fixture-password',
    role: 'member',
  },
  carol: {
    name: 'carol',
    displayName: 'Carol',
    id: asUserId('mem_fixture_carol'),
    email: 'carol@example.com',
    password: 'carol-fixture-password',
    role: 'member',
  },
}

export const REPO_PATH = '/repo'

/** A member's view of the live feed: a real `/client` socket plus HTTP healing. */
export interface FeedView {
  /** Every frame the socket received, in order. */
  readonly frames: ServerMessage[]
  /** Every change carried by a `feedDelta` frame since the socket opened. */
  deltas(): FeedChange[]
  /** The member's bootstrap snapshot over `sync.changesSince({ cursor: null })`. */
  bootstrap(): Promise<FeedSnapshot>
  /** Wait until a frame satisfies `pred` (or throw after `ms`). */
  until(pred: () => boolean, ms?: number): Promise<void>
  close(): void
}

export interface MemberSession {
  readonly member: FixtureMember
  readonly cookie: string
  readonly trpc: TRPCClient<AppRouter>
  fetch(path: string, init?: RequestInit): Promise<Response>
  feed(): Promise<FeedView>
}

export interface AgentActor {
  readonly sessionId: SessionId
  readonly client: IssueTrpc
  /** `podium issue <args>` from inside the session, through the daemon relay. */
  cli(args: string[]): Promise<string>
  /** An MCP issue tool call from inside the session, through the daemon relay. */
  mcp(tool: string, input: Record<string, unknown>): Promise<string>
}

export interface TwoMemberInstance {
  readonly handle: Awaited<ReturnType<typeof startServer>>
  readonly origin: string
  readonly members: typeof MEMBERS
  readonly machines: { readonly alice: MachineId; readonly bob: MachineId }
  readonly tasks: { readonly alice: IssueId; readonly bob: IssueId }
  readonly sessions: {
    readonly alice: SessionId
    readonly bob: SessionId
    readonly bobOnAliceTask: SessionId
  }
  /** Sign in as the member (cached per member) and act over HTTP and the feed. */
  as(member: MemberName): Promise<MemberSession>
  /** POST `/auth/login` for the member and return the raw response (Carol's is refused). */
  login(member: MemberName): Promise<Response>
  /** Act as a session's agent over the daemon relay. */
  agent(sessionId: SessionId, opts?: { outsideScope?: boolean }): AgentActor
  /** The feed as the legacy device-grade principal sees it (design gap 7). */
  legacyDeviceFeed(): Promise<FeedSnapshot>
  close(): Promise<void>
}

export type FeedSnapshot = Extract<SyncChangesSinceResult, { kind: 'snapshot' }>

export type FeedChange = FeedDeltaMessage['changes'][number]

/** Ids of the rows of one entity that a list of pushed feed changes touched. */
export function changedIds(changes: readonly FeedChange[], entity: string): string[] {
  return changes.filter((change) => change.entity === entity).map((change) => change.entityId)
}

/** The session and task ids a snapshot carries. */
export function snapshotIds(snapshot: FeedSnapshot): { sessions: string[]; issues: string[] } {
  return {
    sessions: snapshot.sessions.map((session) => session.sessionId),
    issues: (snapshot.issueProjections ?? []).map((issue) => issue.id),
  }
}

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export async function startTwoMemberInstance(): Promise<TwoMemberInstance> {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  const stateDir = mkdtempSync(join(tmpdir(), 'podium-two-member-'))
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
  )
  process.env.PODIUM_STATE_DIR = stateDir
  const handle = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
  const origin = `http://127.0.0.1:${handle.port}`
  const registry = handle.registry
  const store = registry.sessionStore
  const relayServers: Array<Awaited<ReturnType<typeof startAgentRelayServer>>> = []
  const sockets: WebSocket[] = []

  const close = async () => {
    for (const ws of sockets) ws.close()
    for (const relay of relayServers) await relay.close()
    await handle.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  }

  try {
    // PEOPLE. Alice is the admin every fresh instance already has; Bob and Carol
    // are added the way an accepted invite adds them (a row plus a credential).
    const at = new Date().toISOString()
    const { alice, bob, carol } = MEMBERS
    await store.users.setEmail(alice.id, alice.email)
    await store.users.setPasswordHash(alice.id, await hashPassword(alice.password), at)
    for (const member of [bob, carol]) {
      await store.users.create(
        {
          id: member.id,
          displayName: member.displayName,
          email: member.email,
          role: member.role,
          createdAt: at,
          disabledAt: null,
        },
        await hashPassword(member.password),
      )
    }
    await store.users.disable(carol.id, at, alice.id)

    // MACHINES. Each with custody for its member, `/repo` reported, and a fake
    // daemon whose relay hub answers its agents' `podium issue` calls.
    const machines = { alice: asMachineId('machine-alice'), bob: asMachineId('machine-bob') }
    const relayFor = new Map<MachineId, Awaited<ReturnType<typeof startAgentRelayServer>>>()
    for (const [name, machineId] of Object.entries(machines) as Array<[MemberName, MachineId]>) {
      await store.machines.upsertMachine({
        id: machineId,
        name: machineId,
        hostname: machineId,
        tokenHash: `${machineId}-token`,
        ownerUserId: MEMBERS[name].id,
        assignment: { server: false, agentExecution: true },
      })
      await store.repos.addRepo(REPO_PATH, machineId)
      const hub = createAgentRelayHub((msg: DaemonMessage) =>
        registry.gateway.routeDaemonFrame(machineId, msg),
      )
      await attachDaemonWithInventory(registry, machineId, (msg: ControlMessage) => {
        if (msg.type === 'agentRelayResult') hub.onResult(msg)
      })
      const relay = await startAgentRelayServer({ port: 0, relay: (req) => hub.relay(req) })
      relayServers.push(relay)
      relayFor.set(machineId, relay)
    }

    // TASKS. One per active member, each homed in a worktree on its owner's machine.
    const createTask = async (owner: FixtureMember, machineId: MachineId) => {
      const task = await registry.issues.crud.create({
        repoPath: REPO_PATH,
        title: `${owner.name}'s task`,
        startNow: false,
        ownerUserId: owner.id,
      })
      await registry.issues.crud.update(task.id, {
        worktreePath: `/wt/${owner.name}-task`,
        machineId,
      })
      return task.id
    }
    const tasks = {
      alice: await createTask(alice, machines.alice),
      bob: await createTask(bob, machines.bob),
    }

    // SESSIONS. Private to whoever started them, whatever task they sit on.
    const startSession = async (
      owner: FixtureMember,
      machineId: MachineId,
      issueId: IssueId,
      title: string,
    ) =>
      (
        await registry.modules.sessions.createSession({
          ownerUserId: owner.id,
          agentKind: 'claude',
          cwd: `/wt/${owner.name}-session-${title}`,
          title,
          machineId,
          issueId,
          // What `sessions.create` passes for a signed-in human: the starter is
          // both the requested owner and the binding principal.
          binding: { principal: { kind: 'user', userId: owner.id } },
        })
      ).sessionId
    const sessions = {
      alice: await startSession(alice, machines.alice, tasks.alice, 'alice-own'),
      bob: await startSession(bob, machines.bob, tasks.bob, 'bob-own'),
      bobOnAliceTask: await startSession(bob, machines.bob, tasks.alice, 'bob-on-alice-task'),
    }
    registry.modules.sessions.flushBroadcasts()

    const machineOfSession = new Map<SessionId, MachineId>([
      [sessions.alice, machines.alice],
      [sessions.bob, machines.bob],
      [sessions.bobOnAliceTask, machines.bob],
    ])

    const login = async (name: MemberName) =>
      await fetch(new URL('/auth/login', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: MEMBERS[name].email, password: MEMBERS[name].password }),
      })

    const signedIn = new Map<MemberName, MemberSession>()
    const as = async (name: MemberName): Promise<MemberSession> => {
      const cached = signedIn.get(name)
      if (cached) return cached
      const response = await login(name)
      if (!response.ok) {
        throw new Error(`${name} could not sign in (${response.status}): ${await response.text()}`)
      }
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
      if (!cookie) throw new Error(`${name}'s login returned no session cookie`)
      const trpc = createTRPCClient<AppRouter>({
        links: [httpLink({ url: `${origin}/trpc`, headers: () => ({ cookie }) })],
      })
      const session: MemberSession = {
        member: MEMBERS[name],
        cookie,
        trpc,
        fetch: async (path, init) =>
          await fetch(new URL(path, origin), {
            ...init,
            headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
          }),
        feed: async () => await openFeed(cookie, trpc),
      }
      signedIn.set(name, session)
      return session
    }

    const openFeed = async (cookie: string, trpc: TRPCClient<AppRouter>): Promise<FeedView> => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.port}/client?v=${CLIENT_WIRE_VERSION}&cap=sync.http.v1`,
        { headers: { cookie } },
      )
      sockets.push(ws)
      const frames: ServerMessage[] = []
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerMessage))
      await new Promise<void>((resolve, reject) => {
        ws.on('error', reject)
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'hello',
              clientId: '',
              viewport: { cols: 80, rows: 24, dpr: 1 },
              wireVersion: CLIENT_WIRE_VERSION,
              caps: ['sync.http.v1', 'metadataDelta'],
            }),
          )
          resolve()
        })
      })
      await until(() => frames.some((frame) => frame.type === 'welcome'))
      return {
        frames,
        deltas: () =>
          frames
            .filter((frame): frame is FeedDeltaMessage => frame.type === 'feedDelta')
            .flatMap((frame) => frame.changes),
        bootstrap: async () => {
          const boot = (await trpc.sync.changesSince.query({
            cursor: null,
          })) as SyncChangesSinceResult
          if (boot.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${boot.kind}`)
          return boot
        },
        until: async (pred, ms) => await until(pred, ms),
        close: () => ws.close(),
      }
    }

    const agent = (sessionId: SessionId, opts: { outsideScope?: boolean } = {}): AgentActor => {
      const machineId = machineOfSession.get(sessionId)
      const relay = machineId ? relayFor.get(machineId) : undefined
      if (!relay) throw new Error(`no fixture relay for session ${sessionId}`)
      const client = makeRelayIssueClient(relay.endpointFor(sessionId), opts)
      const mcp = new IssueToolProvider()
      mcp.setClient(client)
      return {
        sessionId,
        client,
        cli: async (args) => await runIssueCli(args, client),
        mcp: async (tool, input) => await mcp.callMcpTool(tool, input),
      }
    }

    const legacyDeviceFeed = async (): Promise<FeedSnapshot> => {
      // The default principal of the session module's feed read IS the
      // device-grade principal (`DEVICE_GRADE_PRINCIPAL`).
      const boot = await registry.modules.sessions.syncChangesSince(null)
      if (boot.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${boot.kind}`)
      return boot
    }

    return {
      handle,
      origin,
      members: MEMBERS,
      machines,
      tasks,
      sessions,
      as,
      login,
      agent,
      legacyDeviceFeed,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
