/**
 * A TURN RUNS WITH ITS SESSION'S CREDENTIAL, OR NOT AT ALL (credential
 * management §8; epic plan Task 5, acceptance 5 and 6 at the handler).
 *
 * A headless turn carries `access`; any other turn of the session applies what
 * the daemon holds. A daemon that restarted holds nothing until the server's
 * `sessionAccessRefresh`: a turn that arrives first waits, and is refused
 * readably when the refresh never comes. It is never handed to the driver bare.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionHandle } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import type { AccessField } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MarkerJournal, memoryMarkers, SessionAccessStore } from '../control/access'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const SESSION = asSessionId('00000000-0000-4000-8000-0000000000f5')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-turn-secret-0005'

const access: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-0000000000f5',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
}

/**
 * The daemon's PATH holds a runnable `bwrap` (POD-7375), so a passed-in Claude
 * credential's Linux prerequisite is met whatever the test host has installed.
 */
function stubPathWith(...names: string[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'podium-path-'))
  stubbedDirs.push(dir)
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\n', { mode: 0o755 })
  vi.stubEnv('PATH', dir)
}
const stubbedDirs: string[] = []
beforeEach(() => stubPathWith('bwrap'))
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of stubbedDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function daemon(store: SessionAccessStore) {
  const sent: DaemonMessage[] = []
  const handle = {
    binding: { sessionId: SESSION, driver: 'headless', harness: 'claude-code' },
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
    expect(sentEnv(d.handle, 0)).toEqual({
      ANTHROPIC_API_KEY: PLANTED,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    })
    // The second turn of a per-turn driver: no access on the frame, held in memory.
    runtimeHandlers.runtimeSendRequest(d.ctx, turn())
    await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(2))
    expect(sentEnv(d.handle, 1)?.ANTHROPIC_API_KEY).toBe(PLANTED)
  })

  it.runIf(process.platform === 'linux')(
    'a Claude credential turn with no bwrap on PATH is refused readably and never sent (POD-7375)',
    async () => {
      stubPathWith()
      const d = daemon(new SessionAccessStore({ markers: memoryMarkers() }))
      runtimeHandlers.runtimeSendRequest(d.ctx, turn({ access }))
      await vi.waitFor(() => expect(d.results()).toHaveLength(1))
      expect(d.handle.send).not.toHaveBeenCalled()
      expect(d.results()[0]).toMatchObject({
        receipt: { outcome: 'refused', refusal: { reason: 'not_running' } },
      })
      expect(JSON.stringify(d.results()[0])).toMatch(/bubblewrap/)
      expect(JSON.stringify(d.results()[0])).not.toContain(PLANTED)
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
    new SessionAccessStore({ markers }).remember(SESSION, access, 'claude-code')
    const d = daemon(new SessionAccessStore({ markers, waitMs: 5_000 }))
    runtimeHandlers.runtimeSendRequest(d.ctx, turn())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(d.handle.send).not.toHaveBeenCalled()
    d.ctx.access.remember(SESSION, access)
    await vi.waitFor(() => expect(d.handle.send).toHaveBeenCalledTimes(1))
    expect(sentEnv(d.handle, 0)?.ANTHROPIC_API_KEY).toBe(PLANTED)
  })

  it('after a restart with no refresh, the turn is refused readably and never sent (acceptance 6)', async () => {
    const markers: MarkerJournal = memoryMarkers()
    new SessionAccessStore({ markers }).remember(SESSION, access, 'claude-code')
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
