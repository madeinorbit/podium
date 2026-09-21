/**
 * THE WRITER LEASE, DEFINED (POD-4434).
 *
 * podium-host grants exactly one writer. Before this issue the daemon carried
 * a losing attachment on silently: the session looked live and swallowed
 * input (two daemons on one host after an update overlap). The defined
 * behaviour is:
 *
 * - headed attach and spawn-adopt DEMAND the lease (`requireLease`). A refusal
 *   throws WriterLeaseRefusedError naming the label and the holder census;
 *   the daemon answers reattachFailed/spawnError and logs the session — never
 *   a silent reader.
 * - a deliberate takeover is a separate explicit verb, `stealWriter`, issued
 *   on operator action. It parks the losing surface, takes the lease over a
 *   fresh attachment, and wires it through the ONE construction site.
 *
 * The host half (two real attachers against one master) is proved in
 * `packages/pty/src/host.integration.test.ts`. Here the durable door is
 * stubbed and the real handlers run: refusal reaches the frame, steal reaches
 * the bind.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/screen'
import { WriterLeaseRefusedError } from '@podium/process/durable'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachTestTerminal, testSessions } from '../session/testing.js'
import type { DaemonContext } from './context'
import { sessionHandlers, stealTerminalWriter } from './session'

const holder = vi.hoisted(() => ({ durable: undefined as unknown }))

vi.mock('@podium/process/durable', async (importOriginal) => {
  // Spread the real door so WriterLeaseRefusedError stays the real class (the
  // handler's instanceof must see the same identity the stub throws), and only
  // the holder's durable object is stubbed per test.
  const actual = await importOriginal<typeof import('@podium/process/durable')>()
  return { ...actual, durableProcessFor: () => holder.durable }
})

const SESSION = asSessionId('44444444-4444-4444-8444-444444444444')
const LABEL = 'podium-s-writer-lease'

function fakeAttachment(): DurableAttachment {
  return {
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: () => {},
    redraw: () => {},
    geometry: () => ({ cols: 80, rows: 24 }),
    dispose: () => {},
  } as unknown as DurableAttachment
}

interface World {
  ctx: DaemonContext
  sent: DaemonMessage[]
  /** The stubbed adapter: attach refuses, steal takes. */
  adapter: {
    attach: ReturnType<typeof vi.fn>
    steal: ReturnType<typeof vi.fn>
  }
}

function world(): World {
  const sent: DaemonMessage[] = []
  const adapter = {
    attach: vi.fn(async () => {
      throw new WriterLeaseRefusedError(LABEL, 1, 0)
    }),
    steal: vi.fn(async () => ({
      attachment: fakeAttachment(),
      cmd: `podium-host attach /tmp/${LABEL}.sock`,
      redrawOnReattach: false,
      readGeometry: undefined,
    })),
  }
  const durable = {
    locate: async () => ({ adapter, socketPath: `/tmp/${LABEL}.sock` }),
  }
  const ctx = {
    backend: 'host',
    durableLabelFor: () => LABEL,
    sessions: testSessions(),
    settingsDir: join(tmpdir(), 'podium-writer-lease'),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
    observers: {
      initSessionObservers: vi.fn(),
      trackedState: () => undefined,
      clearSession: () => {},
      onResize: () => {},
    },
    sessionCwdTracker: { clear: () => {}, setLaunchCwd: async () => {} },
    sessionBinding: { transition: async () => ({ status: 'unchanged' }) },
    primeInjector: { reset: () => {} },
    reattachGate: (fn: () => Promise<void>) => fn(),
    tailSeedGate: () => {},
    send: (msg: DaemonMessage) => sent.push(msg),
  } as unknown as DaemonContext
  // The handlers under test reach the durable door through `durableProcessFor`;
  // point this world's holder at the stub.
  holder.durable = durable
  return { ctx, sent, adapter }
}

const reattachMessage = () =>
  ({
    type: 'reattach',
    sessionId: SESSION,
    durableLabel: LABEL,
    cwd: '/w',
    // A shell takes the plain host-recovery route with no driver handle to
    // stub; the lease demand is identical for every headed kind.
    agentKind: 'shell',
    lastKnownGeometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: 't-lease',
      machineAccess: 'allowed',
      principal: { kind: 'user', userId: 'user:sole' },
    },
  }) as unknown as Parameters<typeof sessionHandlers.reattach>[1]

describe('a refused writer lease', () => {
  it('answers reattachFailed naming the session instead of holding a silent reader', async () => {
    const { ctx, sent } = world()
    sessionHandlers.reattach(ctx, reattachMessage())
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'reattachFailed')).toBe(true))

    const failed = sent.find((m) => m.type === 'reattachFailed')
    expect(failed).toMatchObject({ sessionId: SESSION })
    expect((failed as { reason: string }).reason).toContain(LABEL)
    // Nothing was acquired, so nothing is held: no Terminal, no reaped bridge.
    expect(ctx.sessions.get(SESSION)?.terminal).toBeUndefined()
  })
})

describe('the stealWriter verb', () => {
  it('takes the lease, wires the stolen surface, and reports a bind', async () => {
    const { ctx, sent, adapter } = world()
    await stealTerminalWriter(ctx, {
      type: 'stealWriter',
      sessionId: SESSION,
      durableLabel: LABEL,
      agentKind: 'shell',
      cwd: '/w',
    })

    expect(adapter.steal).toHaveBeenCalledTimes(1)
    // The stolen surface is the session's ONE Terminal, built through the same
    // construction site as spawn and reattach.
    expect(ctx.sessions.get(SESSION)?.terminal).toBeDefined()
    expect(ctx.sessions.get(SESSION)?.label).toBe(LABEL)
    const bind = sent.find((m) => m.type === 'bind')
    expect(bind).toBeDefined()
    expect(sent.some((m) => m.type === 'reattachFailed')).toBe(false)
  })

  it('answers reattachFailed when the takeover itself is refused', async () => {
    const { ctx, sent, adapter } = world()
    adapter.steal.mockRejectedValueOnce(new Error('abduco has no writer lease to steal'))
    sessionHandlers.stealWriter(ctx, {
      type: 'stealWriter',
      sessionId: SESSION,
      durableLabel: LABEL,
      agentKind: 'shell',
      cwd: '/w',
    })
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'reattachFailed')).toBe(true))
    expect(ctx.sessions.get(SESSION)?.terminal).toBeUndefined()
  })
})

describe('park drops the Terminal and keeps the process', () => {
  it('the session keeps its label, screen, held resize and replay cursor', async () => {
    const { ctx } = world()
    const owned = ctx.sessions.ensure(SESSION)
    owned.label = LABEL
    // A live surface, a held viewer ask, and a replay cursor.
    attachTestTerminal(ctx, SESSION, fakeAttachment())
    owned.pendingResize = { cols: 100, rows: 30 }
    owned.seqReader = () => 41n
    const screen = owned.screen()
    expect(owned.attached).toBe(true)

    owned.park()

    expect(owned.attached).toBe(false)
    expect(owned.terminal).toBeUndefined()
    // The PROCESS side survives the park: label, screen, held resize, cursor.
    expect(owned.label).toBe(LABEL)
    expect(owned.peekScreen()).toBe(screen)
    expect(owned.pendingResize).toEqual({ cols: 100, rows: 30 })
    expect(owned.seqReader?.()).toBe(41n)
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})
