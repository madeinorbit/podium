// WHICH VARIABLES A SPAWN DELETES, decided at the frame (POD-2296).
//
// The bun twin (`apps/daemon/test/managed-account-env.bun.test.ts`) proves the
// deletion reaches a real process's real environ. What it cannot reach is the
// NATIVE LOGIN pane: that frame runs `<cli> login`, so there is no shell to ask
// for its environment and no way to run one without driving a real OAuth flow.
// This file pins the decision instead of the effect, by capturing the options the
// daemon hands the PTY layer.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from '@podium/pty'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'

/** Claude's hook settings file is written here at spawn; nothing reads it back. */
const settingsDir = mkdtempSync(join(tmpdir(), 'podium-strip-env-settings-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

let captured: SpawnOptions | undefined

vi.mock('@podium/pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/pty')>()
  return {
    ...actual,
    spawnAgent: (opts: SpawnOptions) => {
      captured = opts
      return {
        pid: 4242,
        onFrame: () => () => {},
        onTitle: () => () => {},
        onExit: () => () => {},
        write: () => {},
        resize: () => {},
        redraw: () => {},
        geometry: () => ({ cols: opts.cols, rows: opts.rows }),
        dispose: () => {},
      }
    },
  }
})

const { sessionHandlers } = await import('./session')

function contextForSpawn(): DaemonContext {
  return {
    send: () => {},
    instanceId: 'default',
    backend: 'none',
    machineId: 'strip-env-test-machine',
    settingsDir,
    launch: (_kind: string, opts: { cwd: string }) => ({
      cmd: '/bin/true',
      args: [],
      cwd: opts.cwd,
    }),
    bridges: new Map(),
    durableLabels: new Map(),
    pendingResizes: new Map(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: { enqueue: () => {}, remove: () => {} },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext
}

async function spawnOptionsFor(frame: Record<string, unknown>): Promise<SpawnOptions> {
  captured = undefined
  await sessionHandlers.spawn(contextForSpawn(), {
    type: 'spawn',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: 'strip-env-transition',
      machineAccess: 'allowed',
      principal: { kind: 'system', job: 'spawn-strip-env-test' },
    },
    ...frame,
  } as Parameters<typeof sessionHandlers.spawn>[1])
  const start = Date.now()
  while (!captured && Date.now() - start < 5_000) await new Promise((r) => setTimeout(r, 10))
  if (!captured) throw new Error('the daemon never reached the PTY layer')
  return captured
}

beforeEach(() => {
  captured = undefined
})

it('deletes the vars that would outrank a claude session’s own login', async () => {
  const opts = await spawnOptionsFor({ sessionId: 'strip-claude', agentKind: 'claude-code' })
  expect(opts.stripEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
})

it('deletes them for a NATIVE LOGIN pane, which is filed as a shell', async () => {
  // THE ONE THAT WOULD HAVE BEEN MISSED. `accounts/native-login.ts` creates the
  // session with agentKind 'shell' and loginHarness set — so reading agentKind
  // alone would exempt the exact pane whose purpose is to establish an account,
  // and `claude login` would run under the inherited key it is meant to replace.
  const opts = await spawnOptionsFor({
    sessionId: 'strip-login',
    agentKind: 'shell',
    loginHarness: 'claude-code',
  })
  expect(opts.stripEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
})

it('leaves a plain operator shell alone', async () => {
  const opts = await spawnOptionsFor({ sessionId: 'strip-shell', agentKind: 'shell' })
  expect(opts.stripEnv).toEqual([])
})

it('never deletes a credential the server put on the frame', async () => {
  const opts = await spawnOptionsFor({
    sessionId: 'strip-managed',
    agentKind: 'claude-code',
    env: { ANTHROPIC_API_KEY: 'sk-managed' },
  })
  expect(opts.stripEnv).toEqual(['ANTHROPIC_AUTH_TOKEN'])
  expect(opts.env?.ANTHROPIC_API_KEY).toBe('sk-managed')
})
