/**
 * A TURN RUNS WITH ITS SESSION'S CREDENTIAL, OR NOT AT ALL (credential
 * management §8; epic plan Task 5, acceptance 5 and 6 at the handler).
 *
 * A headless turn carries `access`; any other turn of the session applies what
 * the daemon holds. A daemon that restarted holds nothing until the server's
 * `sessionAccessRefresh`: a turn that arrives first waits, and is refused
 * readably when the refresh never comes. It is never handed to the driver bare.
 */

import type { AgentSessionHandle } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import type { AccessField } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { type MarkerJournal, memoryMarkers, SessionAccessStore } from '../control/access'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const SESSION = asSessionId('00000000-0000-4000-8000-0000000000f5')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-turn-secret-0005'

/** A key Codex reads from its variable: the turn's own env carries it. */
const access: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-0000000000f5',
  delivery: { kind: 'env', variable: 'OPENAI_API_KEY', secret: PLANTED },
}
/** A key Claude Code reads from a pipe on Linux (POD-7378). */
const claudeAccess = (secret = PLANTED): AccessField => ({
  credentialId: 'cred_00000000-0000-4000-8000-0000000000f6',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret },
})

function daemon(store: SessionAccessStore, harness = 'codex') {
  const sent: DaemonMessage[] = []
  const handle = {
    binding: { sessionId: SESSION, driver: 'headless', harness },
    send: vi.fn(async () => ({
      outcome: 'accepted',
      deliveredAs: 'when-ready',
      at: new Date().toISOString(),
    })),
  } as unknown as AgentSessionHandle
  const ctx = {
    access: store,
    agentRuntime: { handleFor: () => handle },
    send: (msg: DaemonMessage) => void sent.push(msg),
  } as unknown as DaemonContext
  return { ctx, handle, results: () => sent.filter((m) => m.type === 'runtimeSendResult') }
}

const turn = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'runtimeSendRequest',
    requestId: `req-${Math.random()}`,
    turnId: `turn-${Math.random()}`,
    sessionId: SESSION,
    text: 'go',
    origin: 'controller',
    delivery: 'when-ready',
    ...extra,
  }) as never

const sentEnv = (handle: AgentSessionHandle, call: number) =>
  (vi.mocked(handle.send).mock.calls[call]?.[0] as { env?: Record<string, string> }).env

describe('runtimeSendRequest and the session credential', () => {
  it('a turn carrying access runs with it, and the next turn without it still does', async () => {
    const d = daemon(new SessionAccessStore({ markers: memoryMarkers() }))
    runtimeHandlers.runtimeSendRequest(d.ctx, turn({ access }))
    await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(1))
    expect(sentEnv(d.handle, 0)).toEqual({ OPENAI_API_KEY: PLANTED })
    // The second turn of a per-turn driver: no access on the frame, held in memory.
    runtimeHandlers.runtimeSendRequest(d.ctx, turn())
    await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(2))
    expect(sentEnv(d.handle, 1)?.OPENAI_API_KEY).toBe(PLANTED)
  })

  it.runIf(process.platform === 'linux')(
    'a Claude turn on Linux carries its key in no variable: the engine layer pipes it (POD-7378)',
    async () => {
      const d = daemon(new SessionAccessStore({ markers: memoryMarkers() }), 'claude-code')
      runtimeHandlers.runtimeSendRequest(d.ctx, turn({ access: claudeAccess() }))
      await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(1))
      // No variable and no scrub switch, so no bubblewrap is needed either.
      expect(sentEnv(d.handle, 0)).toBeUndefined()
      expect(JSON.stringify(vi.mocked(d.handle.send).mock.calls[0])).not.toContain(PLANTED)
      // The secret stays with the session, for the engine layer's pipe.
      expect(d.ctx.access.current(SESSION)).toEqual(claudeAccess())
    },
  )

  it.runIf(process.platform === 'linux')(
    'a Claude turn with an empty key is refused readably and never sent (POD-7378)',
    async () => {
      const d = daemon(new SessionAccessStore({ markers: memoryMarkers() }), 'claude-code')
      runtimeHandlers.runtimeSendRequest(d.ctx, turn({ access: claudeAccess('  ') }))
      await vi.waitFor(() => expect(d.results()).toHaveLength(1))
      expect(d.handle.send).not.toHaveBeenCalled()
      expect(d.results()[0]).toMatchObject({
        receipt: { outcome: 'refused', refusal: { reason: 'not_running' } },
      })
      expect(JSON.stringify(d.results()[0])).toMatch(/credential .* is empty/)
    },
  )

  it('a session with no credential sends its turn with no env', async () => {
    const d = daemon(new SessionAccessStore({ markers: memoryMarkers() }))
    runtimeHandlers.runtimeSendRequest(d.ctx, turn())
    await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(1))
    expect(sentEnv(d.handle, 0)).toBeUndefined()
  })

  it('after a restart, a turn before the refresh waits and then runs with it (acceptance 6)', async () => {
    const markers: MarkerJournal = memoryMarkers()
    new SessionAccessStore({ markers }).remember(SESSION, access, 'codex')
    const d = daemon(new SessionAccessStore({ markers, waitMs: 5_000 }))
    runtimeHandlers.runtimeSendRequest(d.ctx, turn())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(d.handle.send).not.toHaveBeenCalled()
    d.ctx.access.remember(SESSION, access)
    await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(1))
    expect(sentEnv(d.handle, 0)?.OPENAI_API_KEY).toBe(PLANTED)
  })

  it('after a restart with no refresh, the turn is refused readably and never sent (acceptance 6)', async () => {
    const markers: MarkerJournal = memoryMarkers()
    new SessionAccessStore({ markers }).remember(SESSION, access, 'codex')
    const d = daemon(new SessionAccessStore({ markers, waitMs: 20 }))
    runtimeHandlers.runtimeSendRequest(d.ctx, turn())
    await vi.waitFor(() => expect(d.results()).toHaveLength(1))
    expect(d.handle.send).not.toHaveBeenCalled()
    expect(d.results()[0]).toMatchObject({
      receipt: { outcome: 'refused', refusal: { reason: 'not_running' } },
    })
    expect(JSON.stringify(d.results()[0])).toMatch(/credential .* has not arrived/)
  })
})
