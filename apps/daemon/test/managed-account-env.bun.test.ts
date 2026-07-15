// apps/daemon/test/managed-account-env.bun.test.ts
//
// RUNNER: bun test only (`bun run test:bun`).
//
// The managed-credential spawn path (#216) has a vitest integration twin in
// scripts/managed-account-spawn.integration.test.ts, but vitest runs under NODE — so it
// exercises the node-pty backend. The SHIPPED daemon is bun-compiled and therefore uses
// the Bun.Terminal PTY backend (a compiled daemon has no node-pty fallback at all — see
// packages/agent-bridge/src/pty/index.ts). Env is handed to the OS by the BACKEND, so the
// backend the users actually run must be proven too, not just the one the test runner picks.
//
// Same two directions as the vitest twin, against a real process's real environment:
//   POSITIVE — a credential on the spawn frame reaches the child's environ.
//   NEGATIVE — a spawn with no env injects no ANTHROPIC_API_KEY (the silent-re-auth
//              regression that would change every existing native-account user's auth).
//
// Reaps by explicit pid. Never pattern-kills — a `pkill` here could take out the
// developer's live agent sessions.

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand, hasBunTerminal } from '@podium/agent-bridge'
import { SpawnMessage } from '@podium/protocol'
import { credentialEnv } from '@podium/runtime'
import type { DaemonContext } from '../src/control/context'
import { sessionHandlers } from '../src/control/session'

const CREDENTIAL = 'sk-test-xyz'

let settingsDir: string
let home: string
let savedHome: string | undefined
let savedShell: string | undefined
let savedKey: string | undefined

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'podium-bun-spawn-settings-'))
  home = mkdtempSync(join(tmpdir(), 'podium-bun-spawn-home-'))
  savedHome = process.env.HOME
  savedShell = process.env.SHELL
  savedKey = process.env.ANTHROPIC_API_KEY
  // The daemon passes its OWN environment down to the agent, so "Podium injected nothing"
  // is only observable against a clean ambient env: an empty HOME (no ~/.bashrc that might
  // export the var itself), a known shell, and no inherited ANTHROPIC_API_KEY.
  process.env.HOME = home
  process.env.SHELL = '/bin/bash'
  process.env.ANTHROPIC_API_KEY = undefined as unknown as string
  delete process.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedKey
  rmSync(settingsDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await Bun.sleep(25)
  }
}

/** Spawn a real shell through the daemon's real spawn handler and return what its
 *  own `env` printed. `env` (not `echo $VAR`) so we read the process's actual environ. */
async function dumpEnvOfSpawnedProcess(
  sessionId: string,
  env: Record<string, string> | undefined,
): Promise<string> {
  let buffer = ''
  let lastFrameAt = Date.now()
  const bridges = new Map<string, { pid: number; write(b64: string): void; dispose(): void }>()
  const ctx = {
    send: () => {},
    backend: 'none', // bare PTY child: no abduco/tmux master can outlive this test
    launch: agentLaunchCommand,
    settingsDir,
    bridges,
    outputScheduler: {
      enqueue: (_id: string, data: string) => {
        buffer += Buffer.from(data, 'base64').toString('utf8')
        lastFrameAt = Date.now()
      },
      remove: () => {},
    },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext

  // The real wire frame through the real schema.
  const msg = SpawnMessage.parse({
    type: 'spawn',
    sessionId,
    agentKind: 'shell',
    cwd: process.cwd(),
    geometry: { cols: 120, rows: 30 },
    ...(env ? { env } : {}),
  })
  sessionHandlers.spawn(ctx, msg)

  const session = bridges.get(sessionId)
  if (!session) throw new Error('daemon never bridged the session (spawn failed)')
  const pid = session.pid
  try {
    await waitFor(() => buffer.length > 0)
    session.write(Buffer.from('env\n', 'utf8').toString('base64'))
    // PODIUM_SESSION_ID is bound by the daemon on EVERY spawn: seeing it proves the dump
    // really printed and that this process came out of Podium's spawn path — which is what
    // makes the credential's ABSENCE in the negative case meaningful rather than just early.
    await waitFor(() => buffer.includes(`PODIUM_SESSION_ID=${sessionId}`))
    while (Date.now() - lastFrameAt < 250) await Bun.sleep(25) // let the dump settle
    return buffer
  } finally {
    session.dispose() // reap by explicit pid — never pattern-kill
    await waitFor(() => !alive(pid), 5_000)
  }
}

it('runs on the Bun terminal PTY — the backend the shipped daemon uses', () => {
  expect(hasBunTerminal()).toBe(true)
})

it('POSITIVE: a managed credential reaches the real spawned process env (Bun backend)', async () => {
  const env = credentialEnv({ provider: 'anthropic', kind: 'api-key', credential: CREDENTIAL })
  expect(env).toEqual({ ANTHROPIC_API_KEY: CREDENTIAL })

  const dump = await dumpEnvOfSpawnedProcess('bun-managed', env)
  expect(dump).toContain(`ANTHROPIC_API_KEY=${CREDENTIAL}`)
  expect(dump).toContain('PODIUM_SESSION_ID=bun-managed')
})

it('NEGATIVE: no env on the frame injects NO ANTHROPIC_API_KEY (Bun backend)', async () => {
  const dump = await dumpEnvOfSpawnedProcess('bun-native', undefined)
  expect(dump).toContain('PODIUM_SESSION_ID=bun-native') // the dump really happened
  expect(dump).not.toContain('ANTHROPIC_API_KEY=')
  expect(dump).not.toContain(CREDENTIAL)
})
