// WHICH BINARY EACH SESSION RUNS (managed installs §6.2, POD-7272).
//
// A harness process keeps the release it started on; the session's next
// process takes the current one; a restarted daemon still knows which binary
// each surviving session runs. The record of that is one row per session in
// the install ledger:
//
//   1. every launch mode writes it, at the one step every launch runs before
//      its process exists; the modes come from the code (`LAUNCH_MODES`), and
//      the table of launch sites is typed over them, so a new mode without a
//      site here does not compile;
//   2. it goes when the session's processes are stopped, and at daemon start
//      for the sessions whose process did not survive;
//   3. a reattach after a restart rebuilds the context from it, not from the
//      inventory, so the context names the older executable;
//   4. an engine waking on a managed release that is no longer current is
//      moved to the current one in the same home; anything else keeps its
//      context;
//   5. housekeeping keeps a release while a row names it.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BoundCommand,
  type HarnessContext,
  type HarnessInstallation,
  harnessCommand,
  LAUNCH_MODES,
  type LaunchMode,
  noAgentTerms,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import { testHarnessContext, testLaunchPosture } from '@podium/harness/driver/testing'
import { housekeepReleases, InstallLedger, writeInstallReceipt } from '@podium/harness/inventory'
import { asSessionId, type SessionId } from '@podium/model'
import type { SpawnOptions } from '@podium/process/screen'
import type { BuiltinHarnessKind } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryMarkers, SessionAccessStore } from './control/access'
import type { DaemonContext } from './control/context'
import { launchTerminalProcess, sessionHandlers, stopSessionProcess } from './control/session'
import { DaemonHarnessRuntime } from './harness-runtime'
import { HomeRegistry } from './homes/registry'
import { createOpencodeClientTerminals } from './runtime/opencode-attach'
import type { ClientProcessOwner } from './session/clients.js'
import { createSessionEngineScope } from './session/engines'
import { stubDurable, testSessions, testTerminalRuntime } from './session/testing.js'
import {
  buildDriverHarnessContext,
  engineSessionHarnessContext,
  sessionHarnessContextFor,
} from './session-harness-context'
import {
  dropInstallsOfLostSessions,
  ledgerSessionInstalls,
  type SessionInstallRecords,
  sessionInstallRow,
} from './session-installs'
import { nodePrepareLaunchPorts, prepareLaunch } from './session-posture'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

let root: string
let harnessesDir: string
let records: SessionInstallRecords

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-session-installs-'))
  harnessesDir = join(root, 'harnesses')
  records = ledgerSessionInstalls(harnessesDir)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Where release `n` of `kind` keeps its executable. */
const releaseExecutable = (kind: string, n: number, version: string) =>
  join(harnessesDir, kind, `${n}-${version}`, 'bin', kind)

/** A context on Podium's release `n` of `kind`. */
function managedContext(kind: BuiltinHarnessKind, n: number, version = `1.${n}.0`) {
  return testHarnessContext({
    kind,
    executable: releaseExecutable(kind, n, version),
    version,
    provenance: 'managed',
    release: n,
    home: join(root, 'person'),
  })
}

const bound = (context: HarnessContext, args: string[] = []): BoundCommand =>
  harnessCommand(context, { args }, noAgentTerms('test stand-in: runs no agent'))

// ---------------------------------------------------------------------------
// 1. Every launch mode writes the row

/** One launch through the real site of each mode; returns what it ran. */
type LaunchSite = (sessionId: SessionId) => Promise<HarnessInstallation>

/** The terminal spawn: the real spawn handler, the PTY layer stood in for. */
const terminalSite: LaunchSite = async (sessionId) => {
  let launched: HarnessInstallation | undefined
  const fakeSpawn = (_opts: SpawnOptions) => ({
    pid: 4242,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    resize: () => {},
    dispose: () => {},
  })
  const ctx = {
    send: () => {},
    instanceId: 'default',
    backend: 'none',
    durable: stubDurable(fakeSpawn),
    machineId: 'session-installs-test-machine',
    settingsDir: join(root, 'settings'),
    homeDir: join(root, 'person'),
    // The test seam binds the context it is handed, as production does.
    launch: (_kind: string, opts: { cwd: string; harnessContext: HarnessContext }) => {
      launched = opts.harnessContext.installation
      return harnessCommand(
        opts.harnessContext,
        { args: [], cwd: opts.cwd },
        noAgentTerms('test stand-in: runs no agent'),
      )
    },
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: { enqueue: () => {}, remove: () => {} },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
    access: new SessionAccessStore({ markers: memoryMarkers() }),
    sessionInstalls: records,
  } as unknown as DaemonContext
  ctx.agentRuntime = testTerminalRuntime(
    ctx,
    launchTerminalProcess,
  ) as unknown as DaemonContext['agentRuntime']
  await sessionHandlers.spawn(ctx, {
    type: 'spawn',
    sessionId,
    agentKind: 'claude-code',
    cwd: root,
    geometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: `t-${sessionId}`,
      machineAccess: 'allowed',
      principal: { kind: 'system', job: 'session-installs-test' },
    },
  } as Parameters<typeof sessionHandlers.spawn>[1])
  await vi.waitFor(() => expect(records.get(sessionId)).toBeDefined())
  if (!launched) throw new Error('the terminal spawn never reached its launch')
  return launched
}

/** The session layer's engine start; the host refuses after the start's prep. */
const engineScope = () =>
  createSessionEngineScope(
    stubDurable(() => undefined),
    {
      sessions: testSessions(),
      hostAvailable: () => true,
      sessionInstalls: records,
    },
  )

const sites = {
  terminal: terminalSite,
  engine: async (sessionId) => {
    const context = managedContext('codex', 3)
    await engineScope()
      .startEngine({
        label: `engine-${sessionId}`,
        sessionId,
        command: bound(context, ['app-server']),
        cwd: root,
        env: {},
        stripEnv: [],
      })
      .catch(() => {})
    return context.installation
  },
  // A one-shot turn goes through the same door, for its session.
  turn: async (sessionId) => {
    const context = managedContext('claude-code', 2)
    await engineScope()
      .startEngine({
        label: `podium-${sessionId}`,
        turnFor: sessionId,
        command: bound(context, ['-p', 'hi']),
        cwd: root,
        env: {},
        stripEnv: [],
      })
      .catch(() => {})
    return context.installation
  },
  client: async (sessionId) => {
    const context = testHarnessContext({
      kind: 'opencode',
      executable: '/opt/person/bin/opencode',
      version: '1.19.6',
    })
    const clients: ClientProcessOwner = {
      spawnClient: async () => {
        throw new Error('recorded')
      },
      reclaimClient: async () => {},
      hasClientMaster: () => false,
    }
    const sessions = testSessions()
    sessions.ensure(sessionId).harnessContext = context
    const terminals = createOpencodeClientTerminals({
      sessions,
      clients,
      frames: () => {},
      harnessContext: async () => context,
      launchPosture: async () => testLaunchPosture(context),
      sessionInstalls: records,
    } as never)
    await terminals
      .attach({
        sessionId,
        target: {
          kind: 'opencode',
          conversation: 'ses_1',
          endpoint: { address: 'http://127.0.0.1:4100', username: 'podium', secret: 's' },
          workdir: root,
        } as never,
      })
      .catch(() => {})
    return context.installation
  },
} satisfies Record<LaunchMode, LaunchSite>

describe('every launch mode records the session install', () => {
  it('has a launch site here for each launch mode the code declares', () => {
    expect(Object.keys(sites).sort()).toEqual([...LAUNCH_MODES].sort())
  })

  it.each([
    ...LAUNCH_MODES,
  ])('%s: the row names the installation the process runs', async (mode) => {
    const sessionId = asSessionId(`launch-${mode}`)
    const installation = await sites[mode](sessionId)
    expect(records.get(sessionId)).toEqual(sessionInstallRow(sessionId, installation))
  })

  it("a managed launch records its release folder's number; the person's install none", async () => {
    await sites.engine(asSessionId('managed'))
    await sites.client(asSessionId('external'))
    expect(records.get(asSessionId('managed'))).toMatchObject({
      provenance: 'managed',
      release: 3,
    })
    expect(records.get(asSessionId('external'))).toMatchObject({
      provenance: 'external',
      release: null,
    })
  })

  it('an engine that serves no session records nothing', async () => {
    await engineScope()
      .startEngine({
        label: 'probe',
        command: bound(managedContext('codex', 3)),
        cwd: root,
        env: {},
        stripEnv: [],
      })
      .catch(() => {})
    expect(records.list()).toEqual([])
  })

  it('the next process of a session replaces its row', async () => {
    const sessionId = asSessionId('next')
    const ports = nodePrepareLaunchPorts({}, records)
    await prepareLaunch(bound(managedContext('codex', 1)), ports, { session: sessionId })
    await prepareLaunch(bound(managedContext('codex', 2)), ports, { session: sessionId })
    expect(records.list()).toEqual([
      sessionInstallRow(sessionId, managedContext('codex', 2).installation),
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. The row goes with the session's processes

describe('a row goes when its session stops, or did not survive a restart', () => {
  /** Enough of a DaemonContext for `stopSessionProcess` (as server-reap.test.ts). */
  function stopCtx(durable?: { has: () => Promise<boolean> }): DaemonContext {
    return {
      backend: durable ? 'host' : 'none',
      ...(durable ? { durable: { ...durable, kill: async () => {} } } : {}),
      settingsDir: join(root, 'settings'),
      sessions: testSessions(),
      durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
      observers: { clearSession: () => {} },
      outputScheduler: { remove: () => {} },
      portableStateFence: { runSync: (fn: () => void) => fn() },
      agentRuntime: {
        handleFor: () => undefined,
        serverHandleFor: () => undefined,
        journalledServerProcess: () => undefined,
        clearTerminal: () => {},
      },
      send: () => {},
      access: new SessionAccessStore({ markers: memoryMarkers() }),
      sessionInstalls: records,
    } as unknown as DaemonContext
  }

  it('is removed once the session’s processes are reaped', async () => {
    const sessionId = asSessionId('stopped')
    records.record(sessionId, managedContext('codex', 1).installation)
    records.record(asSessionId('other'), managedContext('codex', 1).installation)
    await stopSessionProcess(stopCtx({ has: async () => false }), { sessionId })
    expect(records.get(sessionId)).toBeUndefined()
    expect(records.get(asSessionId('other'))).toBeDefined()
  })

  it('stays while a process of the session may still run', async () => {
    const sessionId = asSessionId('stuck')
    records.record(sessionId, managedContext('codex', 1).installation)
    await stopSessionProcess(stopCtx({ has: async () => true }), { sessionId })
    expect(records.get(sessionId)).toBeDefined()
  })

  it('at daemon start, drops the rows of sessions that did not survive and keeps the rest', async () => {
    const installation = managedContext('codex', 1).installation
    for (const id of ['lost-a', 'survivor', 'lost-b']) records.record(asSessionId(id), installation)
    const inherited = records.list().map((row) => row.sessionId)
    // A session this daemon started since: not one of the inherited rows.
    records.record(asSessionId('started-since'), installation)

    const dropped = await dropInstallsOfLostSessions(
      records,
      inherited,
      async (id) => id === 'survivor',
    )

    expect(dropped).toEqual(['lost-a', 'lost-b'])
    expect(records.list().map((row) => row.sessionId)).toEqual(['started-since', 'survivor'])
  })

  it('keeps the row of a session whose survival cannot be read', async () => {
    records.record(asSessionId('unknown'), managedContext('codex', 1).installation)
    await dropInstallsOfLostSessions(records, [asSessionId('unknown')], async () => {
      throw new Error('host unreachable')
    })
    expect(records.get(asSessionId('unknown'))).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3 and 4. Reattach and engine wake

const CRED = 'cred_aaaaaaaa-0000-4000-8000-000000007272'

/** An inventory whose Podium install of codex is release `n`. */
function inventoryOn(n: number): (generation: number) => Promise<ResolvedHarnessInventory> {
  return async (generation) => {
    const snapshot = testHarnessSnapshot({ codex: '/opt/person/bin/codex' }, generation)
    const path = releaseExecutable('codex', n, `1.${n}.0`)
    return {
      ...snapshot,
      managed: new Map([
        ['codex', { kind: 'codex', path, version: `1.${n}.0`, generation, release: n }],
      ]),
    }
  }
}

/** A daemon whose inventory offers codex release `n`, with the session rows,
 *  homes and access every daemon life on this machine shares. */
function daemonOn(
  n: number,
  shared: { homes: HomeRegistry; access: SessionAccessStore },
): DaemonContext {
  return {
    harnessRuntime: new DaemonHarnessRuntime({ buildSnapshot: inventoryOn(n) }),
    homeDir: join(root, 'person'),
    sessions: testSessions(),
    access: shared.access,
    homes: shared.homes,
    sessionInstalls: records,
  } as unknown as DaemonContext
}

async function machine() {
  const homes = new HomeRegistry({ root: join(root, 'homes') })
  const access = new SessionAccessStore({ markers: memoryMarkers() })
  const home = (await homes.ensure(CRED, 'codex')).home
  /** A session whose access names the Podium home, so it runs Podium's install. */
  const inHome = (id: string): SessionId => {
    const sessionId = asSessionId(id)
    access.remember(
      sessionId,
      { credentialId: CRED, delivery: { kind: 'home', homeId: home.homeId } },
      'codex',
    )
    return sessionId
  }
  return { shared: { homes, access }, home, inHome }
}

/** A process of `sessionId` started the way every launch starts. */
async function launch(ctx: DaemonContext, sessionId: SessionId): Promise<HarnessContext> {
  const context = await buildDriverHarnessContext(ctx, 'codex', undefined, sessionId)
  await prepareLaunch(bound(context), nodePrepareLaunchPorts({}, records), { session: sessionId })
  ctx.sessions.ensure(sessionId).harnessContext = context
  return context
}

describe('a restarted daemon names the binary that really runs', () => {
  it('reattach rebuilds from the row: the older release, in the same home', async () => {
    const { shared, home, inHome } = await machine()
    const terminal = inHome('terminal-survivor')
    const engine = inHome('engine-survivor')
    const before = daemonOn(1, shared)
    await launch(before, terminal)
    await launch(before, engine)

    // The daemon restarts; release 2 has become current meanwhile. Reattach
    // makes the survivors' entries first, as recovery does.
    const after = daemonOn(2, shared)
    after.sessions.ensure(terminal)
    const reattached = await sessionHarnessContextFor(after, terminal, 'codex')
    const adopted = await engineSessionHarnessContext(after, engine, 'codex', undefined)

    for (const context of [reattached, adopted]) {
      expect(context?.installation).toMatchObject({
        executable: releaseExecutable('codex', 1, '1.1.0'),
        provenance: 'managed',
        release: 1,
      })
      expect(context?.harnessHome).toMatchObject({ id: home.homeId, dir: home.dir })
    }
    // Kept on the session from then on.
    expect(after.sessions.get(terminal)?.harnessContext).toBe(reattached)
  })

  it('a session with no row is rebuilt from the current inventory, as before', async () => {
    const { shared, inHome } = await machine()
    const fresh = inHome('no-row')
    const context = await sessionHarnessContextFor(daemonOn(2, shared), fresh, 'codex')
    expect(context?.installation.executable).toBe(releaseExecutable('codex', 2, '1.2.0'))
  })
})

describe('an engine wake leaves a managed release that is no longer current', () => {
  it('rebuilds with the current release and the same home when no engine runs', async () => {
    const { shared, home, inHome } = await machine()
    const sessionId = inHome('parked')
    const ctx = daemonOn(1, shared)
    const held = await launch(ctx, sessionId)
    // Release 2 is published while the session is parked; its engine exited.
    ;(ctx as { harnessRuntime: DaemonHarnessRuntime }).harnessRuntime = new DaemonHarnessRuntime({
      buildSnapshot: inventoryOn(2),
    })
    ctx.sessions.ensure(sessionId).engine = { label: 'engine-parked' }

    const woken = await engineSessionHarnessContext(
      ctx,
      sessionId,
      'codex',
      undefined,
      async () => false,
    )

    expect(woken).not.toBe(held)
    expect(woken.installation).toMatchObject({
      executable: releaseExecutable('codex', 2, '1.2.0'),
      release: 2,
    })
    expect(woken.harnessHome).toEqual(held.harnessHome)
    expect(woken.harnessHome?.id).toBe(home.homeId)
    expect(ctx.sessions.get(sessionId)?.harnessContext).toBe(woken)
  })

  it('keeps the held context while the engine still runs on it (its client runs the same binary)', async () => {
    const { shared, inHome } = await machine()
    const sessionId = inHome('running')
    const ctx = daemonOn(1, shared)
    const held = await launch(ctx, sessionId)
    ;(ctx as { harnessRuntime: DaemonHarnessRuntime }).harnessRuntime = new DaemonHarnessRuntime({
      buildSnapshot: inventoryOn(2),
    })
    ctx.sessions.ensure(sessionId).engine = { label: 'engine-running' }

    const context = await engineSessionHarnessContext(
      ctx,
      sessionId,
      'codex',
      undefined,
      async (label) => label === 'engine-running',
    )
    expect(context).toBe(held)
  })

  it('keeps a release that is still current', async () => {
    const { shared, inHome } = await machine()
    const sessionId = inHome('current')
    const ctx = daemonOn(1, shared)
    const held = await launch(ctx, sessionId)
    expect(
      await engineSessionHarnessContext(ctx, sessionId, 'codex', undefined, async () => false),
    ).toBe(held)
  })

  it("keeps the person's own install, current or not (POD-6546)", async () => {
    const ctx = daemonOn(2, {
      homes: new HomeRegistry({ root: join(root, 'homes') }),
      access: new SessionAccessStore({ markers: memoryMarkers() }),
    })
    const sessionId = asSessionId('person')
    const held = testHarnessContext({ kind: 'codex', executable: '/opt/older/bin/codex' })
    ctx.sessions.ensure(sessionId).harnessContext = held
    expect(
      await engineSessionHarnessContext(ctx, sessionId, 'codex', undefined, async () => false),
    ).toBe(held)
  })
})

// ---------------------------------------------------------------------------
// 5. Housekeeping reads the rows

describe('housekeeping keeps a release while a session row names it', () => {
  function release(n: number, version: string): void {
    const dir = join(harnessesDir, 'codex', `${n}-${version}`)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    writeInstallReceipt(dir, {
      format: 1,
      harness: 'codex',
      version,
      executable: 'bin/codex',
      integrity: { kind: 'none', reason: 'test' },
      source: 'https://downloads.fake-harness.invalid/releases',
      installedAt: new Date().toISOString(),
    })
  }

  it('keeps release 1 while a session runs on it, and deletes it once the row is gone', async () => {
    const ledger = InstallLedger.open({ harnessesDir })
    try {
      ledger.requestInstall('codex', 'person')
      for (let n = 1; n <= 3; n += 1) release(n, `1.${n}.0`)
      const lock = ledger.acquireInstallLock({ label: 'test', autoRenew: false })
      if (!lock.acquired) throw new Error('no lock')
      ledger.allocateReleaseNumber('codex', lock.lock)
      ledger.publishRelease('codex', 2, lock.lock)
      ledger.publishRelease('codex', 3, lock.lock)
      lock.lock.release()
    } finally {
      ledger.close()
    }
    const sessionId = asSessionId('on-release-1')
    await prepareLaunch(bound(managedContext('codex', 1)), nodePrepareLaunchPorts({}, records), {
      session: sessionId,
    })
    const folders = () => readdirSync(join(harnessesDir, 'codex')).sort()

    expect(housekeepReleases('codex', { harnessesDir })).toEqual({ outcome: 'swept', removed: [] })
    expect(folders()).toEqual(['1-1.1.0', '2-1.2.0', '3-1.3.0'])

    records.remove(sessionId)
    expect(housekeepReleases('codex', { harnessesDir })).toEqual({
      outcome: 'swept',
      removed: ['1-1.1.0'],
    })
    expect(folders()).toEqual(['2-1.2.0', '3-1.3.0'])
  })
})
