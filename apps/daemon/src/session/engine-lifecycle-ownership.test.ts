/**
 * ARMED OWNERSHIP GUARD (spec §4.8 steps 2 and 6): the driver family must
 * never summon a process — the session layer does.
 *
 * The grok family is constructed with a scope-only supervision port and the
 * session layer's engine scope (`SessionEngineScope` over a recording
 * durable) as its ONLY process path. A launch driven through that scope must
 * succeed, summoning exactly one engine into the durable — the family only
 * binds protocol. A family constructed WITHOUT the scope refuses loudly
 * instead of forking a child no restart could re-adopt.
 *
 * THE ADDRESS AND THE JOURNAL (POD-4611, layers §1b: the Driver "uses the
 * engine address it was given" and "must never … journal"). A whole codex
 * session — the real engine host and the real runtime over a fake app-server
 * — runs against a fake owner port with `node:fs` watched: it must dial
 * exactly the address it was handed, report its binding facts WITHOUT an
 * address of its own, and touch no socket file (no mkdir, chmod or rm) and no
 * journal file. The session layer's half — minting, sealing and removing the
 * listener, keeping the record on the entry and on disk — is pinned beside it
 * against the real `SessionEngineScope`.
 *
 * There are deliberately NO `DaemonSession` engine delegates: the scope IS
 * the session layer's arm (one instance over the daemon's engine durable,
 * handed to the long-lived families; per-session identity travels as the
 * label value). A forwarding method on the per-session entry would add a hop
 * and no decision, so the entry holds no scope and exposes no engine verb —
 * and this guard wires none.
 */

import * as fs from 'node:fs'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type {
  CodexJournalEntry,
  CodexRawSocket,
  CodexTransport,
  EngineAttachment,
  EngineSpawnRequest,
  EngineSupervisor,
  SessionEngineOwner,
} from '@podium/harness/driver/host'
import {
  codexEngineFacts,
  codexScopeLabel,
  createCodexEngineHost,
  createCodexRuntime,
  createGrokEngineHost,
  grokEngineFacts,
} from '@podium/harness/driver/host'
import { createMemoryBindingRecords } from '@podium/harness/driver/testing'
import { manifestFor } from '@podium/harness'
import type { DurableProcess } from '@podium/process/durable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startFakeAppServer } from '../../../../packages/harness/src/driver/families/codex/test-support/fake-app-server'
import { driverSlotsOver } from './driver-slots.js'
import { noDurableBackendRefusal } from '../durable-backend'
import { createEngineJournal } from './journal.js'
import { SessionRegistry } from './registry.js'
import { grokAcpProcessKey } from '@podium/harness/driver/host'
import { createSessionEngineScope, engineSocketFile, type EngineJournal } from './engines.js'

/**
 * Every filesystem verb a socket's or a journal's lifecycle needs, watched.
 * Pass-through: the session layer's own tests below still create real files.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const watched = {
    mkdirSync: vi.fn(actual.mkdirSync),
    chmodSync: vi.fn(actual.chmodSync),
    rmSync: vi.fn(actual.rmSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
  return { ...actual, ...watched, default: { ...actual, ...watched } }
})

const SESSION = asSessionId('33333333-3333-4333-8333-333333333333')
const FACTS = grokEngineFacts(manifestFor('grok')!)

function recordingScope(spawned: Array<{ label: string; cmd: string }>) {
  const attachment = {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
      write: async () => 0,
    },
    dispose: () => {},
  }
  const hostAdapter = {
    kind: 'host',
    spawnHeadless: async (opts: { label: string; cmd: string }) => {
      spawned.push({ label: opts.label, cmd: opts.cmd })
      return attachment
    },
  }
  const recordingDurable = {
    backend: 'host',
    primary: hostAdapter,
    all: [hostAdapter],
  } as unknown as DurableProcess
  return createSessionEngineScope(recordingDurable, { sessions: new SessionRegistry() })
}

function familyDeps(
  supervision: EngineSupervisor,
  engines: unknown,
) {
  return {
    facts: FACTS,
    resources: () => undefined,
    buildEnv: () => ({}),
    gracefulExitMs: 1,
    checkVersion: async () => ({ drivable: true as const }),
    supervision,
    engines,
  } as unknown as Parameters<typeof createGrokEngineHost>[0]
}

describe('engine lifecycle ownership (§4.8: the session layer summons, the family binds)', () => {
  it('a family launch through the session scope summons through the session owner', async () => {
    // Scope-only: the supervision port carries no process verb any more, so
    // there is nothing here FOR the family to summon through.
    const supervision: EngineSupervisor = {
      scopeUnitFor: () => undefined,
    }

    const spawned: Array<{ label: string; cmd: string }> = []
    const sessionEngines = recordingScope(spawned)
    const host = createGrokEngineHost(
      familyDeps(supervision, sessionEngines.ownerFor(FACTS.journalNamespace)),
    )

    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    expect(endpoint.process.key).toBe(grokAcpProcessKey(FACTS, SESSION))
    expect(endpoint.alive()).toBe(true)
    // The session layer summoned exactly one engine, under the session label.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      label: grokAcpProcessKey(FACTS, SESSION),
      cmd: 'grok',
    })
  })

  it('a family with no session owner refuses instead of summoning', async () => {
    const supervision: EngineSupervisor = {
      scopeUnitFor: () => undefined,
    }
    const host = createGrokEngineHost(familyDeps(supervision, undefined))
    await expect(host.launch({ sessionId: SESSION, workdir: '/tmp' })).rejects.toThrow(
      /requires the session engine owner/,
    )
  })
})

// ---------------------------------------------------------------------------
// POD-4611: the family is handed its address and reports its binding
// ---------------------------------------------------------------------------

const CODEX = codexEngineFacts(manifestFor('codex')!)

/** The engine's Unix listener as a raw socket, bridged onto a fake
 *  app-server's line transport: one JSON-RPC document per frame. */
function rawSocketOver(transport: CodexTransport): CodexRawSocket {
  const closers: Array<() => void> = []
  return {
    send(payload, cb) {
      transport.write(`${payload}\n`)
      cb?.()
    },
    on(event: 'message' | 'error', cb: (...args: never[]) => void) {
      if (event !== 'message') return
      const deliver = cb as unknown as (message: { toString(): string }, binary: boolean) => void
      transport.onLine({
        line: (line) => deliver({ toString: () => line }, false),
        closed: () => {
          for (const close of closers.splice(0)) close()
        },
      })
    },
    once(event: 'open' | 'close' | 'error', cb: (...args: never[]) => void) {
      const fire = cb as unknown as () => void
      if (event === 'open') setTimeout(fire, 0)
      else if (event === 'close') closers.push(fire)
    },
    off: () => {},
    terminate: () => transport.close(),
  } as CodexRawSocket
}

function heldEngine(): EngineAttachment {
  return {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
    },
    dispose: () => {},
  }
}

/** The owner port as a family sees it, recording every report and act. */
function recordingOwner() {
  const records = createMemoryBindingRecords<CodexJournalEntry>()
  const reported: CodexJournalEntry[] = []
  const released: SessionId[] = []
  const destroyed: Array<{ label: string; sessionId: SessionId | undefined }> = []
  const started: EngineSpawnRequest[] = []
  const minted: string[] = []
  const owner: SessionEngineOwner<CodexJournalEntry> = {
    async startEngine(req) {
      started.push(req)
      const address = `unix:///run/podium-test/${minted.length}-engine.sock`
      minted.push(address)
      return { attachment: heldEngine(), address }
    },
    reattachEngine: () => Promise.reject(new Error('no re-attach in this run')),
    engineAlive: async () => false,
    async destroyEngine(label, sessionId) {
      destroyed.push({ label, sessionId })
    },
    bound(facts) {
      reported.push(facts)
      records.bound(facts)
    },
    released(sessionId) {
      released.push(sessionId)
      records.released(sessionId)
    },
    recorded: (sessionId) => records.recorded(sessionId),
  }
  return { owner, reported, released, destroyed, started, minted }
}

describe('the family is handed its address and reports its binding (POD-4611)', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockClear()
    vi.mocked(fs.chmodSync).mockClear()
    vi.mocked(fs.rmSync).mockClear()
    vi.mocked(fs.writeFileSync).mockClear()
  })

  it('a codex session run touches no socket file and no journal: it dials what it is handed and reports', async () => {
    const server = startFakeAppServer()
    const dialled: string[] = []
    const run = recordingOwner()
    const host = createCodexEngineHost({
      facts: CODEX,
      engines: run.owner,
      supervision: { scopeUnitFor: () => undefined },
      stageAttachment: async () => {
        throw new Error('attachments are not under test')
      },
      resources: () => undefined,
      buildEnv: () => ({}),
      gracefulExitMs: 1,
      checkVersion: async () => ({ drivable: true as const }),
      dialSocket: async (address) => {
        dialled.push(address)
        return rawSocketOver(server.transport)
      },
    })
    const runtime = createCodexRuntime(host, driverSlotsOver(new SessionRegistry()))
    const handle = await runtime.driver.create({
      harness: 'codex',
      selection: { auth: 'subscription', platform: 'linux', available: ['codex-app-server'] },
      workdir: '/tmp/codex-ownership',
      model: {},
      instructions: { supported: false, reason: 'test' },
      mcpServers: { supported: false, reason: 'test' },
    })
    const sessionId = handle.binding.sessionId

    // HANDED, NOT COMPOSED: the engine was told the address the owner minted,
    // and the family dialled exactly that one.
    expect(run.minted).toHaveLength(1)
    expect(run.started[0]?.listen?.argv(run.minted[0]!)).toEqual(['--listen', run.minted[0]])
    expect(run.started[0]?.args).not.toContain('--listen')
    expect(dialled).toEqual([run.minted[0]])

    // REPORTED, NOT JOURNALLED: the family's facts carry no address of its
    // own — the session layer records the one it minted beside them.
    expect(run.reported.length).toBeGreaterThan(0)
    for (const facts of run.reported) {
      expect(facts).not.toHaveProperty('address')
      expect(facts).not.toHaveProperty('clientAddress')
    }

    await handle.kill()
    expect(run.released).toContain(sessionId)
    expect(run.destroyed).toEqual([{ label: codexScopeLabel(CODEX, sessionId), sessionId }])

    // No socket-file or journal-file act anywhere in the family's run.
    expect(fs.mkdirSync).not.toHaveBeenCalled()
    expect(fs.chmodSync).not.toHaveBeenCalled()
    expect(fs.rmSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })
})

describe('the session layer mints, seals and removes the listener, and keeps the record (POD-4611)', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-4611-scope-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function memoryStore(): EngineJournal<{ sessionId: SessionId }> {
    const entries = new Map<SessionId, { sessionId: SessionId }>()
    return {
      read: (sessionId) => entries.get(sessionId),
      write: (entry) => void entries.set(entry.sessionId, entry),
      clear: (sessionId) => void entries.delete(sessionId),
    }
  }

  function scopeOver(
    sessions: SessionRegistry,
    store: EngineJournal<{ sessionId: SessionId }>,
    hostAvailable?: () => boolean,
  ) {
    const spawned: Array<{ label: string; args: string[] }> = []
    const killed: string[] = []
    const hostAdapter = {
      kind: 'host',
      spawnHeadless: async (opts: { label: string; args: string[] }) => {
        spawned.push({ label: opts.label, args: opts.args })
        return heldEngine()
      },
      attachHeadless: async () => heldEngine(),
      has: async () => true,
      kill: async (label: string) => void killed.push(label),
    }
    const durable = { backend: 'host', primary: hostAdapter, all: [hostAdapter] } as unknown as DurableProcess
    const scope = createSessionEngineScope(durable, {
      sessions,
      socketRoot: () => join(root, 'sock'),
      journalFor: () => store,
      ...(hostAvailable ? { hostAvailable } : {}),
    })
    return { scope, spawned, killed }
  }

  it('mints the address, prepares the root, seals the socket, and removes it on destroy', async () => {
    const sessions = new SessionRegistry()
    const store = memoryStore()
    const { scope, spawned, killed } = scopeOver(sessions, store)
    const owner = scope.ownerFor<{ sessionId: SessionId; n: number }>('ns')
    const label = `podium-cx-${SESSION}`

    const hold = await owner.startEngine({
      sessionId: SESSION,
      label,
      cmd: 'engine',
      args: ['serve'],
      listen: { argv: (address) => ['--listen', address] },
      cwd: '/tmp',
      env: {},
      stripEnv: [],
    })
    expect(hold.address?.startsWith(`unix://${join(root, 'sock')}/`)).toBe(true)
    expect(spawned).toEqual([{ label, args: ['serve', '--listen', hold.address] }])
    expect(statSync(join(root, 'sock')).mode & 0o777).toBe(0o700)
    expect(sessions.get(SESSION)?.engine).toMatchObject({ label, address: hold.address })

    // The engine binds its listener; the first dial seals it to its owner.
    const file = engineSocketFile(hold.address)!
    writeFileSync(file, '', { mode: 0o666 })
    const dial = scope.dialerFor(async (path: string) => {
      expect(path).toBe(file)
      return { once: (_event: 'open', cb: () => void) => cb() }
    })
    await dial(hold.address!)
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // The family reports; the session layer records its own address beside.
    owner.bound({ sessionId: SESSION, n: 1 })
    expect(store.read(SESSION)).toEqual({ sessionId: SESSION, n: 1, address: hold.address })
    expect(owner.recorded(SESSION)).toEqual({ sessionId: SESSION, n: 1, address: hold.address })

    await owner.destroyEngine(label, SESSION)
    expect(killed).toEqual([label])
    expect(existsSync(file)).toBe(false)
    // A stop keeps the record: a later adopt resumes from its facts.
    expect(owner.recorded(SESSION)).toMatchObject({ n: 1 })

    owner.released(SESSION)
    expect(store.read(SESSION)).toBeUndefined()
    expect(sessions.get(SESSION)?.engine).toBeUndefined()
  })

  it('with no podium-host a listener start refuses with the one sentence, minting and spawning nothing (POD-4617)', async () => {
    const sessions = new SessionRegistry()
    const { scope, spawned } = scopeOver(sessions, memoryStore(), () => false)
    const owner = scope.ownerFor<{ sessionId: SessionId }>('ns')
    await expect(
      owner.startEngine({
        sessionId: SESSION,
        label: `podium-cx-${SESSION}`,
        cmd: 'engine',
        args: [],
        listen: { argv: (address) => ['--listen', address] },
        cwd: '/tmp',
        env: {},
        stripEnv: [],
      }),
    ).rejects.toThrow(noDurableBackendRefusal())
    expect(spawned).toEqual([])
    expect(existsSync(join(root, 'sock'))).toBe(false)
    expect(sessions.get(SESSION)?.engine).toBeUndefined()
  })

  it('a destroy after the daemon cleared its entries still removes the listener it recorded', async () => {
    // A full-reap close empties every entry while the engine reaps it started
    // are still in flight; the listener file must not outlive the engine.
    const sessions = new SessionRegistry()
    const { scope, killed } = scopeOver(sessions, memoryStore())
    const owner = scope.ownerFor<{ sessionId: SessionId }>('ns')
    const label = `podium-cx-${SESSION}`
    const hold = await owner.startEngine({
      sessionId: SESSION,
      label,
      cmd: 'engine',
      args: [],
      listen: { argv: (address) => ['--listen', address] },
      cwd: '/tmp',
      env: {},
      stripEnv: [],
    })
    const file = engineSocketFile(hold.address)!
    writeFileSync(file, '')
    owner.bound({ sessionId: SESSION })
    sessions.get(SESSION)?.clear()
    sessions.clear()

    await owner.destroyEngine(label, SESSION)
    expect(killed).toEqual([label])
    expect(existsSync(file)).toBe(false)
  })

  it('a restarted daemon re-attaches with the recorded address, from the durable copy alone', async () => {
    const store = memoryStore()
    store.write({ sessionId: SESSION, address: 'unix:///run/podium-test/survivor.sock' } as never)
    const sessions = new SessionRegistry()
    const { scope } = scopeOver(sessions, store)
    const owner = scope.ownerFor<{ sessionId: SessionId }>('ns')
    const hold = await owner.reattachEngine({ label: 'survivor', fromSeq: 'tail', sessionId: SESSION })
    expect(hold.address).toBe('unix:///run/podium-test/survivor.sock')
    expect(sessions.get(SESSION)?.engine).toMatchObject({
      label: 'survivor',
      address: 'unix:///run/podium-test/survivor.sock',
    })
  })

  it('reads the address a pre-POD-4611 record kept as the family field', () => {
    const previous = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = root
    try {
      createEngineJournal<{ sessionId: SessionId; clientAddress: string }>({ namespace: 'legacy' }).write({
        sessionId: SESSION,
        clientAddress: 'unix:///run/podium-test/legacy.sock',
      })
      const scope = createSessionEngineScope(undefined, { sessions: new SessionRegistry() })
      expect(scope.ownerFor<{ sessionId: SessionId }>('legacy').recorded(SESSION)?.address).toBe(
        'unix:///run/podium-test/legacy.sock',
      )
    } finally {
      if (previous === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previous
    }
  })
})
