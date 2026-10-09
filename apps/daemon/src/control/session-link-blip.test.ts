/**
 * DAEMON LINK BLIP MUST NOT END HEADLESS CODEX/GROK SESSIONS (this issue).
 *
 * A one-second daemon<->server link drop makes the server mark the machine's
 * sessions `reconnecting` and, on re-attach, send a `reattach` probe per
 * survivor. The daemon still holds the live driver handle AND the engine's
 * writer lease (transport state changed; the process did not). Re-adopting
 * through the binding journal here opens a SECOND writer attachment while the
 * first still holds the lease, so the engine host refuses loudly ("writer
 * lease is held elsewhere") and the failed-adoption reap kills the survivor:
 * the transcript goes read-only.
 *
 * The PTY path already short-circuits this: `recoverTerminalProcess` reuses the
 * already-held bridge and re-emits `bind` without a new host attach. The
 * server-family arm (`adoptServerDriverSession`) had no such short-circuit —
 * it always re-adopted. These tests pin the fix: a `reattach` for a session
 * with a live server handle re-binds the SAME session without touching the
 * journal adopt, for both headless Codex (codex-app-server) and Grok
 * (grok-acp).
 */

import type { AgentSessionHandle } from '@podium/harness/driver/host'
import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'
import { testSessions } from '../session/testing.js'

vi.mock('../runtime/server-reap', () => ({ beginServerDriverReap: vi.fn(async () => false) }))

const CODEX_SESSION = asSessionId('4807-link-blip-codex')
const GROK_SESSION = asSessionId('4807-link-blip-grok_')

function liveServerHandle(input: {
  sessionId: SessionId
  driver: 'codex-app-server' | 'grok-acp'
  harness: 'codex' | 'grok'
}): AgentSessionHandle {
  return {
    binding: {
      sessionId: input.sessionId,
      driver: input.driver,
      family: 'server',
      harness: input.harness,
      workdir: '/project',
      resume: { kind: 'resume-kind', value: 'resume-value' },
      process: { key: `podium-cx-${input.sessionId}`, pid: 4242 },
      bindingVersion: 3,
    },
    state: async () => ({
      phase: 'idle',
      since: '2026-09-29T00:00:00.000Z',
      nativeSubagentCount: 0,
    }),
  } as unknown as AgentSessionHandle
}

function reattachMessage(sessionId: SessionId, agentKind: 'codex' | 'grok'): never {
  return {
    type: 'reattach',
    sessionId,
    durableLabel: `podium-${sessionId}`,
    agentKind,
    cwd: '/project',
    lastKnownGeometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: `reattach:${sessionId}`,
      machineAccess: 'allowed',
      sessionAccess: 'allowed',
      principal: { kind: 'system' },
    },
  } as never
}

function linkBlipWorld(live: AgentSessionHandle) {
  const sent: DaemonMessage[] = []
  // If the daemon re-adopts while it still holds the writer lease, the engine
  // host refuses with "writer lease is held elsewhere" — the production kill
  // chain. The mock reproduces that refusal so a regression kills the session
  // in the test exactly as it did on the host.
  const adoptJournalled = vi.fn(async () => {
    throw new Error(
      'refusing a codex engine whose writer lease is held elsewhere (simulated second attach)',
    )
  })
  const serverHandleFor = vi.fn(() => live)
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    machineId: 'link-blip-test-machine',
    sessions: testSessions(),
    durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
    sessionBinding: {
      transition: vi.fn(async () => ({
        status: 'applied',
        binding: { transitionHistory: [] },
      })),
    },
    agentRuntime: {
      handleFor: vi.fn(() => live),
      serverHandleFor,
      adoptJournalled,
    },
  } as unknown as DaemonContext
  return { ctx, sent, adoptJournalled, serverHandleFor }
}

describe('daemon link blip reuses the live server handle (POD-4807)', () => {
  it('re-binds a live headless Codex session without a second journal adopt', async () => {
    const live = liveServerHandle({
      sessionId: CODEX_SESSION,
      driver: 'codex-app-server',
      harness: 'codex',
    })
    const w = linkBlipWorld(live)

    sessionHandlers.reattach(w.ctx, reattachMessage(CODEX_SESSION, 'codex'))
    await vi.waitFor(() =>
      expect(
        w.sent.some((msg) => msg.type === 'bind' || msg.type === 'reattachFailed'),
      ).toBe(true),
    )

    // No second host attach: the journal adopt is never consulted while this
    // daemon still drives the engine — the second attach is what the host
    // refuses with "another writer is attached".
    expect(w.adoptJournalled).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: CODEX_SESSION,
        driverId: 'codex-app-server',
      }),
    )
    expect(w.sent.some((msg) => msg.type === 'reattachFailed')).toBe(false)
  })

  it('re-binds a live headless Grok session without a second journal adopt', async () => {
    const live = liveServerHandle({
      sessionId: GROK_SESSION,
      driver: 'grok-acp',
      harness: 'grok',
    })
    const w = linkBlipWorld(live)

    sessionHandlers.reattach(w.ctx, reattachMessage(GROK_SESSION, 'grok'))
    await vi.waitFor(() =>
      expect(
        w.sent.some((msg) => msg.type === 'bind' || msg.type === 'reattachFailed'),
      ).toBe(true),
    )

    expect(w.adoptJournalled).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: GROK_SESSION,
        driverId: 'grok-acp',
      }),
    )
    expect(w.sent.some((msg) => msg.type === 'reattachFailed')).toBe(false)
  })
})
