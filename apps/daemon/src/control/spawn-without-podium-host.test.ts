import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterAll, expect, it, vi } from 'vitest'
import { noDurableBackendRefusal } from '../durable-backend'
import { testSessions } from '../session/testing.js'
import type { DaemonContext } from './context'
import { launchSpawn } from './session'

/**
 * NO SPAWN WITHOUT PODIUM-HOST (POD-4617; human decision 2026-09-22: "fail
 * completely; podium-host is part of Podium").
 *
 * A daemon whose durable backend is `none` used to start a raw pty child for
 * every spawn — a session that looked live and survived no restart. Now every
 * spawn — agent, shell and login alike — answers `spawnError` with the one
 * refusal sentence, and nothing is started: no launch command is resolved, no
 * terminal is attached, no bind is sent.
 */

const settingsDir = mkdtempSync(join(tmpdir(), 'podium-no-host-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

function hostlessContext(sent: DaemonMessage[]) {
  const launch = vi.fn((_kind: string, opts: { cwd: string }) => ({
    cmd: '/bin/true',
    args: [],
    cwd: opts.cwd,
  }))
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    instanceId: 'default',
    // No `durable`: this is exactly what a daemon with no podium-host holds.
    backend: 'none',
    machineId: 'no-host-test-machine',
    settingsDir,
    launch,
    // Present so an agent spawn is refused for the host, not for a missing runtime.
    agentRuntime: { bindTerminal: vi.fn(), createTerminal: vi.fn() },
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
    observers: { initSessionObservers: () => {}, clearSession: () => {}, trackedState: () => undefined },
    tailSeedGate: () => {},
    sessionCwdTracker: { setLaunchCwd: vi.fn(async () => {}), clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  }
  return { ctx: ctx as unknown as DaemonContext, launch, setLaunchCwd: ctx.sessionCwdTracker.setLaunchCwd }
}

it.each([
  { name: 'an agent', agentKind: 'claude-code' },
  { name: 'a shell', agentKind: 'shell' },
  { name: 'a native login', agentKind: 'shell', loginHarness: 'claude-code' },
])('refuses $name with no durable backend and starts nothing', async ({ agentKind, loginHarness }) => {
  const sent: DaemonMessage[] = []
  const { ctx, launch, setLaunchCwd } = hostlessContext(sent)
  const sessionId = asSessionId(`no-host-${agentKind}-${loginHarness ?? 'plain'}`)

  await launchSpawn(ctx, {
    type: 'spawn',
    sessionId,
    agentKind,
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
    ...(loginHarness ? { loginHarness } : {}),
  } as Parameters<typeof launchSpawn>[1])

  // The one specific refusal, naming podium-host.
  expect(sent).toEqual([{ type: 'spawnError', sessionId, message: noDurableBackendRefusal() }])
  expect(noDurableBackendRefusal()).toContain('podium-host')
  // And nothing started: no launch resolved, no cwd pinned, no terminal held.
  expect(launch).not.toHaveBeenCalled()
  expect(setLaunchCwd).not.toHaveBeenCalled()
  expect(ctx.sessions.get(sessionId)?.attached).toBeFalsy()
})

it('names Windows, where podium-host does not run yet, in its own words', () => {
  expect(noDurableBackendRefusal('win32')).toContain('podium-host does not run on Windows')
  expect(noDurableBackendRefusal('linux')).toContain('podium-host is missing')
})
