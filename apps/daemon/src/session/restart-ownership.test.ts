/**
 * RESTART OWNERSHIP FOR A CODEX SESSION WITH A NATIVE ATTACH (this issue,
 * REVIEW-4438 §6 item 1; pins the decided cluster-A end state).
 *
 * Decided wording (user, 2026-09-28; ADR 10 "Construction and failure
 * ownership" + layers page §1b):
 * - A1: the driver DECIDES its engine's lifecycle (start, re-attach, stop)
 *   and the session PERFORMS it through the engine port (EngineProcessOwner /
 *   SessionEngineScope), which also owns the socket and journal (POD-4611) and
 *   keeps the record AND the driver handle on the session's entry (POD-4610).
 * - A5: the driver asks for native attach and holds the controller lease; the
 *   session adds the process and the Terminal, which the driver never sees.
 * - A6: the session owns each process by its durable label; the live
 *   attachment sits in the Terminal while attached.
 * - A4: the terminal RuntimeDriver lives in the harness terminal family; the
 *   daemon only wires (POD-4785). This test stays below that seam.
 *
 * The claim: nothing changes owner on a daemon restart. For one codex session
 * with a native attach, before and after the restart:
 * - the session entry is held by the SessionRegistry (one DaemonSession per
 *   session; holders are destroyed by `owned.clear()` + `sessions.clear()` on
 *   daemon close at `apps/daemon/src/host-runtime.ts` and re-created by the
 *   session layer on the next boot's reattach/adopt — never taken over by the
 *   driver);
 * - the Terminal slot is held on the entry (`DaemonSession.terminal`);
 * - the driver handle is held on the entry (`DaemonSession.driver`, written
 *   through the family's own `driverSlotsOver` view; families keep no index);
 * - the engine record is held on the entry (`DaemonSession.engine`) with a
 *   durable copy in the family journal (a restarted daemon re-attaches with
 *   the recorded address, from the durable copy alone);
 * - the client attachment's process is owned by the session layer by its
 *   durable label (`SessionClientScope`); the live attachment sits in the
 *   Terminal while attached; the driver holds only the controller lease.
 *
 * LAYER: daemon session layer (`apps/daemon/src/session/`), hermetic — stub
 * engine/client durables that outlive the daemon the way podium-host masters
 * do, a real SessionRegistry + SessionEngineScope + driverSlotsOver +
 * SessionClientScope + Terminal. No pty, no podium-host, no server. A real
 * podium-host restart is the integration lane (`bun run test:lane --
 * integration …`); web/mobile client builds cannot build on this host, so the
 * daemon layer is where this pins. It extends the durable-copy adopt already
 * pinned in `engine-lifecycle-ownership.test.ts` ("a restarted daemon
 * re-attaches with the recorded address") to the whole session: entry,
 * Terminal, handle, record and client attachment together.
 *
 * Characterization: describes the code as it is at 2619c1c94. Shown red by
 * breaking exactly the rule it names (the mutation and the red run are mailed
 * to POD-4414, not committed).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { AgentSessionHandle, EngineAttachment } from '@podium/harness/driver/host'
import { codexEngineFacts, codexScopeLabel } from '@podium/harness/driver/host'
import { manifestFor } from '@podium/harness'
import type { DurableAttachment, DurableProcess } from '@podium/process/durable'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Terminal } from '../terminal/terminal.js'
import { createSessionClientScope } from './clients.js'
import { driverSlotsOver } from './driver-slots.js'
import { createSessionEngineScope, type EngineJournal } from './engines.js'
import { SessionRegistry } from './registry.js'

const SESSION = asSessionId('66666666-6666-4666-8666-666666666666')
const CODEX = codexEngineFacts(manifestFor('codex')!)
const NAMESPACE = CODEX.journalNamespace

function heldEngineAttachment(): EngineAttachment {
  return {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
      write: async () => 0,
    },
    dispose: () => {},
  }
}

/** A stand-in for the client TUI pty: renders nothing, records nothing. */
function fakeClientAttachment(pid: number): DurableAttachment {
  return {
    pid,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: () => {},
    redraw: () => {},
    dispose: () => {},
  } as unknown as DurableAttachment
}

/**
 * The engine host, as podium-host survives a daemon restart: masters outlive
 * the registry. One shared object across both generations; `kill` is the only
 * removal.
 */
function survivingEngineDurable() {
  const alive = new Set<string>()
  const adapter = {
    kind: 'host',
    spawnHeadless: async (opts: { label: string }) => {
      alive.add(opts.label)
      return heldEngineAttachment()
    },
    attachHeadless: async (opts: { label: string }) => {
      if (!alive.has(opts.label)) throw new Error(`no engine master for ${opts.label}`)
      return heldEngineAttachment()
    },
    has: async (label: string) => alive.has(label),
    kill: async (label: string) => void alive.delete(label),
  }
  const durable = { backend: 'host', primary: adapter, all: [adapter] } as unknown as DurableProcess
  return { durable, alive }
}

/** The client host, same survival rule: the TUI master outlives the daemon. */
function survivingClientDurable() {
  const masters = new Set<string>()
  const adapter = {
    kind: 'abduco',
    spawn: async (opts: { label: string }) => {
      masters.add(opts.label)
      return fakeClientAttachment(5000 + masters.size)
    },
    kill: async (label: string) => void masters.delete(label),
    hasMasterSync: (label: string) => masters.has(label),
  }
  const durable = {
    backend: 'abduco',
    primary: adapter,
    all: [adapter],
    spawn: adapter.spawn,
    kill: adapter.kill,
    hasMasterSync: adapter.hasMasterSync,
  } as unknown as DurableProcess
  return { durable, masters }
}

/** The engine journal, on disk in production: the durable copy that survives. */
function survivingJournal() {
  const entries = new Map<SessionId, { sessionId: SessionId }>()
  const store: EngineJournal<{ sessionId: SessionId }> = {
    read: (sessionId) => entries.get(sessionId),
    write: (entry) => void entries.set(entry.sessionId, entry),
    clear: (sessionId) => void entries.delete(sessionId),
  }
  return { store, entries }
}

/**
 * A driver handle stub. The controller lease rides the handle (A5: the driver
 * holds the engine's controller lease while a human types); the Terminal
 * never does — `terminal` must stay absent on every handle this test mints.
 */
function driverHandle(label: string, leaseHolder: string): AgentSessionHandle {
  return {
    binding: { sessionId: SESSION, process: { key: label, pid: 4242 } },
    controllerLease: { holder: leaseHolder, kind: 'human-controller' },
    stop: async () => {},
    kill: async () => {},
  } as unknown as AgentSessionHandle
}

describe('a daemon restart changes no owner (codex + native attach, decided cluster A)', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-4623-restart-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('entry, Terminal, handle, engine record and client attachment keep their holders across the restart', async () => {
    const engine = survivingEngineDurable()
    const clients = survivingClientDurable()
    const journal = survivingJournal()
    const socketRoot = () => join(root, 'sock')
    const engineLabel = codexScopeLabel(CODEX, SESSION)
    const clientLabel = `podium-test-attach-${SESSION}`

    // -- Generation 1: a running codex session with a native attach ---------
    const sessions1 = new SessionRegistry()
    const scope1 = createSessionEngineScope(engine.durable, {
      sessions: sessions1,
      socketRoot,
      journalFor: () => journal.store,
    })
    const slots1 = driverSlotsOver(sessions1)
    const clientScope1 = createSessionClientScope(clients.durable)!
    expect(clientScope1).toBeDefined()
    const owner1 = scope1.ownerFor<{ sessionId: SessionId }>(NAMESPACE)

    // The driver DECIDES (A1); the session PERFORMS: start through the port.
    const started = await owner1.startEngine({
      sessionId: SESSION,
      label: engineLabel,
      cmd: 'codex',
      args: ['app-server'],
      listen: { argv: (address) => ['--listen', address] },
      cwd: '/tmp',
      env: {},
      stripEnv: [],
    })
    expect(started.address?.startsWith('unix://')).toBe(true)
    // …and reports its binding; the session keeps the record (POD-4611).
    owner1.bound({ sessionId: SESSION })

    // The driver handle binds into the entry's slot (POD-4610), holding the
    // controller lease for the attach (A5).
    const handle1 = driverHandle(engineLabel, 'native-tui-1')
    slots1.set(SESSION, handle1)

    // The session adds the client process and the Terminal (A5); the driver
    // never sees that Terminal.
    const clientAttachment1 = await clientScope1.spawnClient({
      label: clientLabel,
      cmd: 'codex',
      args: ['resume'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    })
    const entry1 = sessions1.ensure(SESSION)
    entry1.client = { label: clientLabel, kind: 'codex' }
    // Mirrored onto the entry's `clientLabel`, as the relay does at open: the
    // label is what teardown names after the policy is retired.
    entry1.clientLabel = clientLabel
    entry1.nativeRequested = true
    const terminal1 = Terminal.attach(clientAttachment1, entry1, { onFrame: () => {} }, { kind: 'client' })
    entry1.replaceTerminal(terminal1)

    // -- Before: each object has its decided holder -------------------------
    const address1 = entry1.engine?.address
    expect(sessions1.get(SESSION)).toBe(entry1)
    expect(entry1.terminal).toBe(terminal1)
    expect(terminal1.attachment).toBe(clientAttachment1)
    expect(entry1.driver).toBe(handle1)
    expect(slots1.get(SESSION)).toBe(handle1)
    expect(entry1.engine).toMatchObject({ label: engineLabel, address: address1 })
    expect(address1).toMatch(/^unix:\/\//)
    expect(journal.store.read(SESSION)).toMatchObject({ address: address1 })
    expect(entry1.client).toMatchObject({ label: clientLabel })
    expect(entry1.clientLabel).toBe(clientLabel)
    // The driver holds the lease and nothing else: no Terminal, no socket
    // path, no journal on the handle.
    expect(handle1).toMatchObject({ controllerLease: { holder: 'native-tui-1' } })
    expect(handle1).not.toHaveProperty('terminal')
    expect(handle1).not.toHaveProperty('engine')
    expect(handle1).not.toHaveProperty('journal')
    // The session owns both processes by durable label (A6): probed through
    // the session scopes, the same verbs production uses.
    expect(await scope1.engineAlive(engineLabel)).toBe(true)
    expect(clientScope1.hasClientMaster(clientLabel)).toBe(true)

    // -- The restart: daemon close destroys every holder (host-runtime.ts) --
    // Server-family reaps start first (POD-4610) while the entries still name
    // their handles; then every entry is cleared and the registry emptied.
    for (const [, owned] of sessions1.entries()) owned.clear()
    sessions1.clear()

    // Holders are gone; processes and the durable copy outlive the daemon.
    expect(sessions1.get(SESSION)).toBeUndefined()
    expect(slots1.get(SESSION)).toBeUndefined()
    expect(entry1.terminal).toBeUndefined()
    expect(entry1.driver).toBeUndefined()
    expect(entry1.engine).toBeUndefined()
    expect(entry1.client).toBeUndefined()
    expect(entry1.clientLabel).toBeUndefined()
    expect(await scope1.engineAlive(engineLabel)).toBe(true)
    expect(clientScope1.hasClientMaster(clientLabel)).toBe(true)
    expect(journal.store.read(SESSION)).toMatchObject({ address: address1 })

    // -- Generation 2: the next boot re-attaches and adopts -----------------
    const sessions2 = new SessionRegistry()
    const scope2 = createSessionEngineScope(engine.durable, {
      sessions: sessions2,
      socketRoot,
      journalFor: () => journal.store,
    })
    const slots2 = driverSlotsOver(sessions2)
    const clientScope2 = createSessionClientScope(clients.durable)!
    const owner2 = scope2.ownerFor<{ sessionId: SessionId }>(NAMESPACE)
    expect(sessions2.get(SESSION)).toBeUndefined()

    // The engine re-attaches with the recorded address, from the durable copy
    // alone — no entry, no handle, no Terminal involved.
    const reattached = await owner2.reattachEngine({ label: engineLabel, fromSeq: 'tail', sessionId: SESSION })
    expect(reattached.address).toBe(address1)
    // The family reports again; the session keeps the record on the NEW entry.
    owner2.bound({ sessionId: SESSION })

    // The client master that outlived the daemon is adopted back under the
    // same durable label (the relay's `adopt`: probe by label, seed the entry).
    expect(clientScope2.hasClientMaster(clientLabel)).toBe(true)
    const clientAttachment2 = await clientScope2.spawnClient({
      label: clientLabel,
      cmd: 'codex',
      args: ['resume'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    })
    const entry2 = sessions2.ensure(SESSION)
    entry2.client = { label: clientLabel, kind: 'codex' }
    entry2.clientLabel = clientLabel
    entry2.nativeRequested = true
    const terminal2 = Terminal.attach(clientAttachment2, entry2, { onFrame: () => {} }, { kind: 'client' })
    entry2.replaceTerminal(terminal2)

    // The driver rebinds a FRESH handle and holds a fresh lease; the old
    // handle is garbage — never re-indexed, never handed the new Terminal.
    const handle2 = driverHandle(engineLabel, 'native-tui-2')
    slots2.set(SESSION, handle2)

    // -- After: same holders, new holder objects, same identities -----------
    expect(entry2).not.toBe(entry1)
    expect(sessions2.get(SESSION)).toBe(entry2)
    expect(terminal2).not.toBe(terminal1)
    expect(entry2.terminal).toBe(terminal2)
    expect(terminal2.attachment).toBe(clientAttachment2)
    expect(handle2).not.toBe(handle1)
    expect(entry2.driver).toBe(handle2)
    expect(slots2.get(SESSION)).toBe(handle2)
    // The old generation's view stays empty: nothing was taken over.
    expect(slots1.get(SESSION)).toBeUndefined()
    expect(entry2.engine).toMatchObject({ label: engineLabel, address: address1 })
    expect(journal.store.read(SESSION)).toMatchObject({ address: address1 })
    expect(entry2.client).toMatchObject({ label: clientLabel, kind: 'codex' })
    expect(entry2.clientLabel).toBe(clientLabel)
    expect(handle2).toMatchObject({ controllerLease: { holder: 'native-tui-2' } })
    expect(handle2).not.toHaveProperty('terminal')
    expect(handle2).not.toHaveProperty('engine')
    // The session still owns both processes by the same durable labels.
    expect(await scope2.engineAlive(engineLabel)).toBe(true)
    expect(clientScope2.hasClientMaster(clientLabel)).toBe(true)
  })
})
