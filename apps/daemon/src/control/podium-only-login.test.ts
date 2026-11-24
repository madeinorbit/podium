/**
 * THE SIGN-IN TERMINAL OF A HARNESS ONLY PODIUM INSTALLED (POD-7494, managed
 * installs §4.2).
 *
 * "Sign in with ChatGPT" in Set up agents opens a login pane (`shell` with
 * `loginHarness`). On a machine where Podium's Codex is the only one, the pane
 * used to be refused ("has only Podium's install ..., which never runs in your
 * own codex folder"). It now runs Podium's Codex in the Podium home, the
 * machine's own login there, and the inventory reads that home's login, so
 * the sign-in lands where sessions on that machine read it. With the person's
 * Codex installed too, the pane keeps running theirs in their own folder, as
 * a session on the machine's own login does. With no Codex at all it is still
 * refused.
 *
 * The real launch fork with the process boundary stubbed: no shell, login CLI
 * or service starts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedHarnessExecutable, ResolvedHarnessInventory } from '@podium/harness'
import { asSessionId, type BuiltinHarnessKind, type Inventory } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withHomeLogins } from '../homes/logins'
import { snapshotHomeFacts } from '../homes/own-login'
import { HomeRegistry } from '../homes/registry'
import { stubDurable, testSessions } from '../session/testing'
import { buildSessionHarnessContext } from '../session-harness-context'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { memoryMarkers, SessionAccessStore } from './access'
import type { DaemonContext } from './context'

vi.mock('../runtime/server-reap', () => ({ beginServerDriverReap: vi.fn(async () => {}) }))
vi.mock('../runtime/instance-process-reaper', () => ({
  reapInstanceSessionProcesses: vi.fn(async () => ({ examined: 0, remaining: 0 })),
}))
vi.mock('../session-uploads', () => ({ removeSessionUploads: vi.fn() }))

const PERSON_CODEX = '/usr/local/bin/codex'
const MANAGED_CODEX = '/state/harnesses/codex/1-0.171.0/codex'

type MachineState = 'only-managed' | 'both' | 'none'

/** Codex on the machine in one state; every other harness as the defaults. */
function snapshotFor(state: MachineState): ResolvedHarnessInventory {
  const base = testHarnessSnapshot({}, 12, {})
  const person = new Map(base.executables)
  const managed = new Map<BuiltinHarnessKind, ResolvedHarnessExecutable>()
  person.delete('codex')
  if (state === 'both')
    person.set('codex', { kind: 'codex', path: PERSON_CODEX, version: '0.160.0', generation: 12 })
  if (state !== 'none')
    managed.set('codex', {
      kind: 'codex',
      path: MANAGED_CODEX,
      version: '0.171.0',
      generation: 12,
      release: 1,
    })
  return { ...base, executables: person, managed }
}

let root: string
let personHome: string
let homes: HomeRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-only-login-'))
  personHome = join(root, 'person')
  mkdirSync(personHome, { recursive: true })
  homes = new HomeRegistry({ root: join(root, 'state', 'homes') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const podiumCodexHome = () => join(root, 'state', 'homes', 'podium', 'codex')

async function openLoginPane(state: MachineState) {
  const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = []
  const sent: DaemonMessage[] = []
  const snapshot = snapshotFor(state)
  const { launchSpawn } = await import('./session.js')
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    instanceId: 'default',
    instanceUuid: 'uuid-login',
    backend: 'none',
    durable: stubDurable((opts) => {
      spawned.push({
        cmd: opts.cmd,
        args: [...(opts.args ?? [])],
        env: { ...(opts.env as Record<string, string>) },
      })
      return {
        pid: 4242,
        onFrame: () => () => {},
        onTitle: () => () => {},
        onExit: () => () => {},
        write: () => {},
        resize: () => {},
        dispose: () => {},
      }
    }),
    machineId: 'm-login',
    settingsDir: root,
    homeDir: personHome,
    access: new SessionAccessStore({ markers: memoryMarkers() }),
    homes,
    launch: () => ({ cmd: '/bin/true', args: [], cwd: '/repo' }),
    harnessRuntime: {
      current: async () => snapshot,
      isCurrent: (s: unknown) => s === snapshot,
      settled: () => snapshot,
    },
    agentRuntime: {
      create: vi.fn(),
      resume: vi.fn(),
      handleFor: () => undefined,
      has: () => false,
      clearTerminal: () => {},
    },
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
    observers: {
      initSessionObservers: () => {},
      clearSession: () => {},
      trackedState: () => undefined,
    },
    tailSeedGate: () => {},
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as Parameters<typeof launchSpawn>[0]
  await launchSpawn(ctx, {
    type: 'spawn',
    sessionId: asSessionId(`codex-login-${state}`),
    agentKind: 'shell',
    loginHarness: 'codex',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
  } as never)
  return { spawned, sent, snapshot, ctx: ctx as unknown as DaemonContext }
}

describe('the native login pane of Codex (POD-7494)', () => {
  it('only Podium’s install: runs Podium’s Codex in the Podium home, no refusal', async () => {
    const { spawned, sent } = await openLoginPane('only-managed')
    expect(sent.filter((m) => m.type === 'spawnError')).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.cmd).toBe(MANAGED_CODEX)
    expect(spawned[0]?.args).toEqual(['login', '--device-auth'])
    expect(spawned[0]?.env.CODEX_HOME).toBe(podiumCodexHome())
    expect(spawned[0]?.env.HOME).toBe(personHome)
  })

  it('both installs: runs the person’s Codex in their own folder, as a session on the machine’s login does', async () => {
    const { spawned, sent } = await openLoginPane('both')
    expect(sent.filter((m) => m.type === 'spawnError')).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.cmd).toBe(PERSON_CODEX)
    expect(spawned[0]?.env.CODEX_HOME).not.toBe(podiumCodexHome())
  })

  it('no install at all: still refused', async () => {
    const { spawned, sent } = await openLoginPane('none')
    expect(spawned).toEqual([])
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'spawnError',
        message: expect.stringContaining('codex is not installed'),
      }),
    ])
  })

  it('a session on the machine’s own login runs where the pane signed in', async () => {
    for (const state of ['only-managed', 'both'] as const) {
      const snapshot = snapshotFor(state)
      const ctx = {
        homeDir: personHome,
        access: new SessionAccessStore({ markers: memoryMarkers() }),
        homes,
        harnessRuntime: { current: async () => snapshot, settled: () => snapshot },
      } as unknown as DaemonContext
      const context = await buildSessionHarnessContext(ctx, 'codex', asSessionId(`s-${state}`))
      if (state === 'only-managed') {
        expect(context.installation.executable).toBe(MANAGED_CODEX)
        expect(context.harnessHome?.dir).toBe(podiumCodexHome())
      } else {
        expect(context.installation.executable).toBe(PERSON_CODEX)
        expect(context.harnessHome).toBeUndefined()
      }
    }
  })
})

describe('the inventory reads the login where the pane signed in (POD-7494)', () => {
  /** What the inventory probe reported: Codex's login from the person's folder. */
  const reported = (): Inventory =>
    ({
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
      tools: [],
    }) as unknown as Inventory

  /** A Codex login file in `dir`, as `codex login` writes it. */
  function signIn(dir: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'a', refresh_token: 'r' } }),
    )
  }

  it('only Podium’s install: the Podium home’s login is the harness’s login', () => {
    const facts = snapshotHomeFacts(snapshotFor('only-managed'))
    const account = { home: personHome, env: {} }
    // No Podium home yet: nobody signed in there.
    const before = withHomeLogins(reported(), homes.list(), account, facts)
    expect(before.agents[0]?.login.state).toBe('out')
    signIn(homes.ensurePodiumHome('codex').home.dir)
    const after = withHomeLogins(reported(), homes.list(), account, facts)
    expect(after.agents[0]?.login.state).toBe('in')
    expect(after.agents[0]?.logins?.[0]).toMatchObject({ homeId: 'default', state: 'in' })
  })

  it('both installs, only Podium’s copy signed in: the Podium home keeps the login (POD-7496)', () => {
    signIn(homes.ensurePodiumHome('codex').home.dir)
    const account = { home: personHome, env: {} }
    const facts = snapshotHomeFacts(snapshotFor('both'), { homes, account })
    const after = withHomeLogins(reported(), homes.list(), account, facts)
    expect(after.agents[0]?.login.state).toBe('in')
    // Once the person signs in to their own copy, theirs is the login again:
    // the inventory reports their folder's login, here signed out.
    signIn(join(personHome, '.codex'))
    const theirs = withHomeLogins(
      reported(),
      homes.list(),
      account,
      snapshotHomeFacts(snapshotFor('both'), { homes, account }),
    )
    expect(theirs.agents[0]?.login.state).toBe('out')
  })

  it('both installs: the person’s folder’s login stays the harness’s login', () => {
    signIn(homes.ensurePodiumHome('codex').home.dir)
    const facts = snapshotHomeFacts(snapshotFor('both'))
    const after = withHomeLogins(reported(), homes.list(), { home: personHome, env: {} }, facts)
    expect(after.agents[0]?.login.state).toBe('out')
  })
})
