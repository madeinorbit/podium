/**
 * ONE TERMINAL PER SESSION, KEPT BY THE ENTRY (POD-4613, layers §1b).
 *
 * The terminal stream is keyed by session id, so a session holds exactly one
 * Terminal at a time. The rule used to live at the call sites — a reattach
 * checked `attached` before its await, steal parked first — and nothing held
 * it across the await. Here the real handlers race: a reattach passes its
 * `attached` check and waits on the host, a spawn for the same session adopts
 * the live label and wires its surface, then the reattach's attach lands and
 * wires a second one. The durable door is stubbed; the handlers are real.
 *
 * Whichever surface wins, the loser must be PARKED — detached, unwired, inert
 * — so exactly one attachment feeds frames and a driver's write reaches
 * exactly one attachment.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/screen'
import { afterAll, expect, it, vi } from 'vitest'
import { testSessions } from '../session/testing.js'
import type { DaemonContext } from './context'

const holder = vi.hoisted(() => ({ durable: undefined as unknown }))

vi.mock('@podium/process/durable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/process/durable')>()
  return { ...actual, durableProcessFor: () => holder.durable }
})
vi.mock('../session-uploads', () => ({ removeSessionUploads: vi.fn() }))

const { launchSpawn, recoverTerminalHost } = await import('./session')

const settingsDir = mkdtempSync(join(tmpdir(), 'podium-terminal-slot-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

const SESSION = asSessionId('46134613-4613-4613-8613-461346134613')
const LABEL = 'podium-s-terminal-slot'

/** A host attachment whose frames the test pushes and whose writes it reads. */
interface FakeAttachment {
  attachment: DurableAttachment
  emit(data: string): void
  written: string[]
  disposed: boolean
}

function fakeAttachment(pid: number, adopted: boolean): FakeAttachment {
  const frames = new Set<(frame: { seq: number; data: Uint8Array }) => void>()
  const fake: FakeAttachment = {
    written: [],
    disposed: false,
    emit(data) {
      for (const cb of [...frames]) cb({ seq: 0, data: new TextEncoder().encode(data) })
    },
    attachment: undefined as unknown as DurableAttachment,
  }
  fake.attachment = {
    pid,
    adopted,
    onFrame: (cb: (frame: { seq: number; data: Uint8Array }) => void) => {
      frames.add(cb)
      return () => frames.delete(cb)
    },
    onTitle: () => () => {},
    onExit: () => () => {},
    write: (b64: string) => fake.written.push(Buffer.from(b64, 'base64').toString()),
    writeBytes: (bytes: Uint8Array) => fake.written.push(new TextDecoder().decode(bytes)),
    resize: () => {},
    redraw: () => {},
    geometry: () => ({ cols: 80, rows: 24 }),
    dispose: () => {
      fake.disposed = true
      frames.clear()
    },
  } as unknown as DurableAttachment
  return fake
}

it('parks the losing Terminal when a reattach and an adopting spawn race for one session', async () => {
  const adopted = fakeAttachment(1001, true)
  const reattached = fakeAttachment(1002, false)
  let landReattach: () => void = () => {}
  const reattachLanded = new Promise<void>((resolve) => {
    landReattach = resolve
  })
  let reattachWaiting: () => void = () => {}
  const reattachIsWaiting = new Promise<void>((resolve) => {
    reattachWaiting = resolve
  })
  const adapter = {
    attach: vi.fn(async () => {
      reattachWaiting()
      await reattachLanded
      return {
        attachment: reattached.attachment,
        cmd: `podium-host attach /tmp/${LABEL}.sock`,
        redrawOnReattach: false,
        readGeometry: undefined,
      }
    }),
  }
  holder.durable = {
    // The spawn finds the label's master still running and adopts it.
    spawn: vi.fn(async () => adopted.attachment),
    locate: async () => ({ adapter, socketPath: `/tmp/${LABEL}.sock` }),
    has: async () => true,
    primary: { attachCommand: (label: string) => `podium-host attach ${label}` },
  }
  const enqueued: string[] = []
  const ctx = {
    send: () => {},
    instanceId: 'default',
    backend: 'host',
    machineId: 'terminal-slot-test-machine',
    settingsDir,
    launch: (_kind: string, opts: { cwd: string }) => ({ cmd: '/bin/true', args: [], cwd: opts.cwd }),
    sessions: testSessions(),
    durableLabelFor: () => LABEL,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: {
      enqueue: (_id: string, data: Uint8Array) => enqueued.push(new TextDecoder().decode(data)),
      remove: () => {},
      priorityOf: () => 1,
    },
    observers: {
      initSessionObservers: () => {},
      clearSession: () => {},
      trackedState: () => undefined,
      onResize: () => {},
    },
    reattachGate: (fn: () => Promise<void>) => fn(),
    tailSeedGate: () => {},
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext

  // 1. The reattach passes its `attached` check and waits on the host.
  const reattach = recoverTerminalHost(ctx, {
    type: 'reattach',
    sessionId: SESSION,
    durableLabel: LABEL,
    agentKind: 'shell',
    cwd: '/repo',
    lastKnownGeometry: { cols: 80, rows: 24 },
  } as unknown as Parameters<typeof recoverTerminalHost>[1])
  await reattachIsWaiting

  // 2. A spawn for the same session adopts the live label and wires its surface.
  await launchSpawn(ctx, {
    type: 'spawn',
    sessionId: SESSION,
    agentKind: 'shell',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
  } as unknown as Parameters<typeof launchSpawn>[1])
  expect((holder.durable as { spawn: ReturnType<typeof vi.fn> }).spawn).toHaveBeenCalledOnce()
  const first = ctx.sessions.get(SESSION)?.terminal
  expect(first?.pid).toBe(1001)

  // 3. The reattach's attach lands and wires a second surface.
  landReattach()
  await reattach
  const second = ctx.sessions.get(SESSION)?.terminal
  expect(second?.pid).toBe(1002)

  // The loser was PARKED: settled, and its attachment detached.
  expect(first?.live).toBe(false)
  expect(adopted.disposed).toBe(true)
  expect(second?.live).toBe(true)
  expect(reattached.disposed).toBe(false)

  // Exactly one attachment feeds the session's frames.
  adopted.emit('from-the-loser')
  reattached.emit('from-the-winner')
  expect(enqueued).toEqual(['from-the-winner'])

  // A driver writes through the session's slot — and one that still holds the
  // loser's reference reaches nothing. Exactly one attachment takes input.
  ctx.sessions.get(SESSION)?.terminal?.write(new TextEncoder().encode('typed'))
  first?.write(new TextEncoder().encode('stale'))
  expect(reattached.written).toEqual(['typed'])
  expect(adopted.written).toEqual([])
})
