/**
 * NOTHING ON DISK (credential management §8 "Memory only", "Never logged";
 * epic plan Task 5, acceptance 7).
 *
 * One launch with a planted secret through the real server and the real
 * daemon, everything pointed at one temporary root:
 *
 *   the server: an on-disk store (database, its WAL, the command and event
 *     trail), a session start on a vault credential, the spawn frame it sends;
 *   the daemon: its state directory (binding store, engine journals, the
 *     credential markers), the real spawn handler with a real PTY child, a
 *     turn carrying `access`, a malformed spawn frame through the frame guard;
 *   both: one log file at debug level.
 *
 * A recursive search of the root finds the secret nowhere, plain or base64.
 * The same search finds a canary logged on purpose, so an empty result means
 * the search looked. Lives in scripts/ because it composes apps/server and
 * apps/daemon in one process (check-boundaries rule 5).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand } from '@podium/harness'
import type { AgentSessionHandle } from '@podium/harness/driver/host'
import { addSink, createLogger, flushSinks, removeSink, setLogLevel } from '@podium/logger'
import { createFileSink } from '@podium/logger/node'
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { directPtyDurableForTests } from '@podium/process/durable'
import { SpawnMessage } from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AccessMarker, SessionAccessStore } from '../apps/daemon/src/control/access'
import type { DaemonContext } from '../apps/daemon/src/control/context'
import { launchTerminalProcess, sessionHandlers } from '../apps/daemon/src/control/session'
import { createFrameGuard } from '../apps/daemon/src/frame-guards'
import { runtimeHandlers } from '../apps/daemon/src/runtime/handlers'
import { createEngineJournal } from '../apps/daemon/src/session/journal.js'
import { SessionRegistry as DaemonSessions } from '../apps/daemon/src/session/registry.js'
import { testTerminalRuntime } from '../apps/daemon/src/session/testing.js'
import { sealCredentialSecret } from '../apps/server/src/modules/credentials/vault'
import { SessionRegistry } from '../apps/server/src/relay'
import { attachHostDaemon } from '../apps/server/src/test-support/host-daemon'
import { openTestStore } from '../apps/server/src/test-support/open-test-store'

/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-nothing-on-disk-0007'
/** Logged on purpose: proves the search reads the log. */
const CANARY = 'canary-FAKE-logged-on-purpose-0007'

let root = ''
const saved: Record<string, string | undefined> = {}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

/** The secret as plain text and in base64 at each of the three alignments. */
function spellings(value: string): string[] {
  const shifted = (prefix: string) => {
    const encoded = Buffer.from(prefix + value).toString('base64')
    // Drop the characters the prefix and the final padding can influence.
    const skip = Math.ceil((prefix.length * 4) / 3)
    return encoded.slice(skip, skip + Math.floor((value.length * 4) / 3) - 4)
  }
  return [value, shifted(''), shifted('x'), shifted('xx'), Buffer.from(value).toString('base64url')]
}

function occurrences(value: string): string[] {
  const wanted = spellings(value)
  return filesUnder(root).filter((file) => {
    const bytes = readFileSync(file).toString('latin1')
    return wanted.some((spelling) => bytes.includes(spelling))
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-no-disk-'))
  for (const key of ['PODIUM_STATE_DIR', 'HOME', 'SHELL', 'ANTHROPIC_API_KEY'])
    saved[key] = process.env[key]
  process.env.PODIUM_STATE_DIR = join(root, 'daemon-state')
  process.env.HOME = join(root, 'home')
  process.env.SHELL = '/bin/bash'
  delete process.env.ANTHROPIC_API_KEY
  mkdirSync(process.env.HOME, { recursive: true })
  mkdirSync(process.env.PODIUM_STATE_DIR, { recursive: true })
})

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

function daemonContext(sent: DaemonMessage[]): DaemonContext {
  const ctx = {
    send: (m: DaemonMessage) => void sent.push(m),
    machineId: 'local',
    instanceId: 'blue',
    durableLabelFor: (id: string) => `podium-blue-${id}`,
    sessions: new DaemonSessions(),
    homeDir: process.env.HOME,
    backend: 'none',
    durable: directPtyDurableForTests(),
    launch: (kind: string, opts: { cwd: string }) =>
      kind === 'shell'
        ? agentLaunchCommand('shell', opts)
        : { cmd: '/bin/bash', args: ['--norc', '--noprofile', '-i'], cwd: opts.cwd },
    settingsDir: join(root, 'daemon-state', 'settings'),
    outputScheduler: { enqueue: () => {}, remove: () => {} },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    bindingStore: { isQuarantined: () => false },
    sessionBinding: {
      transition: async (input: { event: 'spawn' }) => ({
        status: 'unchanged' as const,
        event: input.event,
        binding: {} as never,
      }),
    },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
    // The production marker store: files under the daemon's state directory.
    access: new SessionAccessStore({
      markers: createEngineJournal<AccessMarker>({ namespace: 'session-access' }),
    }),
  } as unknown as DaemonContext
  ctx.agentRuntime = testTerminalRuntime(
    ctx,
    launchTerminalProcess,
  ) as unknown as DaemonContext['agentRuntime']
  return ctx
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('after a launch with a planted secret, nothing on disk holds it (acceptance 7)', () => {
  it('the server store, the daemon state dir and the log file: no secret; the canary is found', async () => {
    const logFile = join(root, 'logs', 'podium.ndjson')
    mkdirSync(join(root, 'logs'), { recursive: true })
    const sink = createFileSink({ path: logFile, minLevel: 'debug' })
    addSink(sink)
    setLogLevel('debug')
    try {
      // THE SERVER: a store on disk, a vault credential, a session start.
      mkdirSync(join(root, 'server'), { recursive: true })
      const store = await openTestStore(join(root, 'server', 'podium.db'))
      const record = await store.credentials.insert({
        ownerUserId: await firstAdminMemberId(store),
        label: 'planted',
        type: 'anthropic.api-key',
      })
      expect(await sealCredentialSecret(store, record, PLANTED, 0)).toBe(1)
      const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
      const frames: ControlMessage[] = []
      await attachHostDaemon(reg, (m) => frames.push(m))
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: root,
        credentialId: record.id,
      })
      const spawnFrame = frames.find((m) => m.type === 'spawn' && m.sessionId === sessionId)
      expect(
        spawnFrame && 'access' in spawnFrame ? spawnFrame.access?.credentialId : undefined,
      ).toBe(record.id)

      // THE DAEMON: the frame as the wire carries it, into the real handler.
      const sent: DaemonMessage[] = []
      const ctx = daemonContext(sent)
      const wire = SpawnMessage.parse(JSON.parse(JSON.stringify(spawnFrame)))
      await sessionHandlers.spawn(ctx, wire)
      await waitFor(() => sent.some((m) => m.type === 'bind' || m.type === 'spawnError'))
      expect(sent.find((m) => m.type === 'spawnError')).toBeUndefined()
      const terminal = ctx.sessions.get(sessionId as SessionId)?.terminal
      if (!terminal) throw new Error('no terminal for the spawned session')

      // A turn carrying access, through the real turn handler.
      const handle = {
        binding: { sessionId, driver: 'headless', harness: 'claude-code' },
        send: vi.fn(async () => ({ outcome: 'accepted', deliveredAs: 'when-ready', at: '' })),
      } as unknown as AgentSessionHandle
      const turnCtx = {
        ...ctx,
        agentRuntime: { handleFor: () => handle },
      } as unknown as DaemonContext
      runtimeHandlers.runtimeSendRequest(turnCtx, {
        type: 'runtimeSendRequest',
        requestId: 'req-no-disk',
        turnId: 'turn-no-disk',
        sessionId: asSessionId(sessionId),
        text: 'go',
        origin: 'controller',
        delivery: 'when-ready',
        access: (wire as { access?: never }).access,
      } as never)
      await waitFor(() => vi.mocked(handle.send).mock.calls.length === 1)

      // A malformed frame of a carrying type, through the frame guard's warning.
      createFrameGuard(ctx).receive(
        Buffer.from(JSON.stringify({ ...wire, geometry: { cols: 'wide', rows: 1 } })),
      )

      // The canary, logged on purpose.
      createLogger('test:no-disk').warn('a canary for the search', { value: CANARY })

      terminal.park()
      await reg.dispose()
      await store.close()
      await flushSinks()

      // The search can find what is there.
      expect(occurrences(CANARY)).toEqual([logFile])
      // The marker for the restart is on disk, and names the credential only.
      expect(filesUnder(join(root, 'daemon-state', 'session-access')).length).toBeGreaterThan(0)
      // And the secret is nowhere.
      expect(occurrences(PLANTED)).toEqual([])
    } finally {
      removeSink(sink)
      await sink.close()
    }
  }, 120_000)
})
