/**
 * END-TO-END: a managed credential reaches a REAL spawned process's environment (#216).
 *
 * Every layer of the managed-account path has unit tests. What none of them prove is the
 * thing the feature actually promises — that the credential Podium holds server-side ends
 * up in the environment of the agent process the daemon forks. This test proves it by
 * dumping a real process's real environment and reading the value back out of the PTY.
 *
 * It drives the WHOLE chain, no layer faked:
 *
 *   accounts table            apps/server/src/store/accounts.ts      (real sqlite + migrations)
 *     -> resolveAccountEnv    apps/server/src/modules/sessions/account-env.ts
 *     -> credentialEnv        packages/runtime/src/settings.ts       (provider/kind -> env var)
 *     -> SpawnMessage.parse   packages/protocol/.../terminal.ts      (real zod wire round-trip)
 *     -> sessionHandlers.spawn apps/daemon/src/control/session.ts    (the real handler)
 *     -> spawnEnv + spawnAgent -> a real /bin/bash on a real PTY
 *     -> `env` -> assert on the bytes the child actually printed
 *
 * Lives in scripts/ because it is the only tier permitted to compose apps/server AND
 * apps/daemon in one process (check-boundaries rule 5, same allowance scripts/host.ts uses).
 *
 * PTY HYGIENE: Podium leaks detached PTY masters when a test forgets to reap (see the
 * agent-bridge notes). Backend is 'none' — a bare node-pty child, no abduco/tmux master to
 * outlive us — and every spawn is disposed by explicit pid and confirmed dead. Nothing here
 * ever pattern-kills, which would be capable of killing the developer's live agents.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand } from '@podium/agent-bridge'
import { type DaemonMessage, SpawnMessage } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../apps/daemon/src/control/context'
import { sessionHandlers } from '../apps/daemon/src/control/session'
import { resolveAccountEnv } from '../apps/server/src/modules/sessions/account-env'
import { AccountsRepository } from '../apps/server/src/store/accounts'

const CREDENTIAL = 'sk-test-xyz'

function openAccountsDatabase() {
  const db = openDatabase(':memory:')
  // This lane owns only the managed-account aggregate. Keeping its fixture at
  // that boundary avoids coupling a real PTY spawn test to the Bun-only full
  // server migration runner used by SessionStore.
  db.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    credential TEXT NOT NULL,
    identity TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  return db
}

/** The server side: a managed anthropic api-key account, resolved to spawn env. */
function managedAccountEnv(): Record<string, string> | undefined {
  const db = openAccountsDatabase()
  const accounts = new AccountsRepository(db)
  accounts.upsert({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: CREDENTIAL,
    identity: 'sk-t…xyz',
    scope: 'role',
    createdAt: 1,
  })
  const env = resolveAccountEnv(accounts, 'managed:anthropic').env
  db.close()
  return env
}

interface Harness {
  ctx: DaemonContext
  sent: DaemonMessage[]
  /** Everything the child wrote to its PTY, as the daemon relayed it. */
  output(): string
  /** Resolves once no new PTY frame has arrived for `quietMs` — so an absence
   *  assertion can't pass merely because the output hadn't arrived yet. */
  settled(quietMs?: number): Promise<void>
}

function makeHarness(settingsDir: string): Harness {
  const sent: DaemonMessage[] = []
  let buffer = ''
  let lastFrameAt = Date.now()
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    // 'none' = a bare node-pty child. No durable master can survive this test.
    machineId: 'local',
    instanceId: 'blue',
    durableLabels: new Map(),
    durableLabelFor: (id: string) => `podium-blue-${id}`,
    homeDir: home,
    backend: 'none',
    // The REAL launch table: agentKind 'shell' -> $SHELL, no args.
    launch: agentLaunchCommand,
    settingsDir,
    bridges: new Map(),
    // Draft sync is outside this env-propagation lane; keep the real spawn,
    // frame, and exit path explicit while disabling its optional driver.
    composerEngine: {
      attach: () => false,
      onData: () => {},
      detach: () => {},
      has: () => false,
    },
    // wireBridge pipes every PTY frame here — this is the daemon's real relay seam,
    // so we assert on exactly the bytes the daemon would have shipped to the server.
    outputScheduler: {
      enqueue: (_id: string, data: string) => {
        buffer += Buffer.from(data, 'base64').toString('utf8')
        lastFrameAt = Date.now()
      },
      remove: () => {},
    },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    // Both methods the real spawn handler reaches for (POD-746): pins launch
    // cwd on every spawn (unawaited) and clears on exit. A stub missing one
    // throws from inside the handler → spawnError, not a type error.
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext

  return {
    ctx,
    sent,
    output: () => buffer,
    async settled(quietMs = 250) {
      while (Date.now() - lastFrameAt < quietMs) await new Promise((r) => setTimeout(r, 25))
    },
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let settingsDir: string
let home: string

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'podium-spawn-settings-'))
  home = mkdtempSync(join(tmpdir(), 'podium-spawn-home-'))
  // The daemon hands its OWN environment down to the agent (spawnAgent spreads
  // process.env), so the negative case can only mean "PODIUM injected nothing" if the
  // ambient environment is clean. Pin all three inputs that would otherwise make this
  // test read the developer's machine instead of the code:
  //   HOME   -> an empty dir, so an interactive bash sources no ~/.bashrc that might
  //             export ANTHROPIC_API_KEY itself (that would be the SHELL's doing, not
  //             Podium's, and would fail the negative case for the wrong reason).
  //   SHELL  -> bash, so `env` behaves identically on a fish/zsh developer's box.
  //   ANTHROPIC_API_KEY -> unset, for the same reason as HOME.
  vi.stubEnv('HOME', home)
  vi.stubEnv('SHELL', '/bin/bash')
  vi.stubEnv('ANTHROPIC_API_KEY', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(settingsDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

/**
 * Spawn a real shell through the daemon's real spawn handler, make it print its
 * environment, and return what it printed. `env` (not `echo $VAR`) on purpose: the
 * child enumerates its own environ, so we observe the process's actual environment
 * rather than a shell expansion we could have fooled ourselves with.
 */
async function spawnAndDumpEnv(
  h: Harness,
  sessionId: string,
  env: Record<string, string> | undefined,
): Promise<string> {
  // The real wire frame, through the real schema — an env the protocol would have
  // rejected can never reach the daemon in production, so it must not here either.
  const msg = SpawnMessage.parse(
    JSON.parse(
      JSON.stringify({
        type: 'spawn',
        sessionId,
        agentKind: 'shell',
        cwd: process.cwd(),
        geometry: { cols: 120, rows: 30 },
        ...(env ? { env } : {}),
      }),
    ),
  )

  sessionHandlers.spawn(h.ctx, msg)

  const bind = h.sent.find((m) => m.type === 'bind')
  const spawnError = h.sent.find((m) => m.type === 'spawnError')
  expect(spawnError, `daemon refused to spawn: ${JSON.stringify(spawnError)}`).toBeUndefined()
  expect(bind, 'daemon never bound the session').toBeDefined()

  const session = h.ctx.bridges.get(sessionId)
  if (!session) throw new Error('no bridge for the spawned session')
  const pid = session.pid

  try {
    await waitFor(() => h.output().length > 0) // shell is up and talking
    session.write(Buffer.from('env\n', 'utf8').toString('base64'))
    // PODIUM_SESSION_ID is bound by the daemon on EVERY spawn, so seeing it in the
    // dump is proof the env actually printed and that this process really came out of
    // Podium's spawn path — which is what makes the absence of ANTHROPIC_API_KEY in
    // the negative case meaningful rather than merely a dump we failed to wait for.
    await waitFor(() => h.output().includes(`PODIUM_SESSION_ID=${sessionId}`))
    await h.settled()
    expect(h.ctx.durableLabels.get(sessionId)).toBe(`podium-blue-${sessionId}`)
    return h.output()
  } finally {
    // Reap by explicit pid. Never pattern-kill: a `pkill -f bash` here would take the
    // developer's live agent sessions with it.
    session.dispose()
    await waitFor(() => !alive(pid), 5_000)
    expect(alive(pid), `leaked PTY child pid ${pid}`).toBe(false)
  }
}

describe('managed account -> real spawned process env (#216)', () => {
  it('POSITIVE: a managed anthropic api-key lands in the spawned process ENVIRONMENT', async () => {
    const env = managedAccountEnv()
    // The server resolved the stored credential into exactly the documented env var.
    expect(env).toEqual({ ANTHROPIC_API_KEY: CREDENTIAL })

    const h = makeHarness(settingsDir)
    const dump = await spawnAndDumpEnv(h, 'sess-managed', env)

    // The child's own `env` listed it — a real process, a real environment.
    expect(dump).toContain(`ANTHROPIC_API_KEY=${CREDENTIAL}`)
    // ...and the credential did not displace Podium's own per-session wiring.
    expect(dump).toContain('PODIUM_SESSION_ID=sess-managed')
    expect(dump).toContain('PODIUM_INSTANCE=blue')
    expect(dump).toContain('PODIUM_SESSION_INSTANCE=blue')
  })

  it('NEGATIVE: a native account (no env on the frame) injects NO ANTHROPIC_API_KEY', async () => {
    // This is the regression that would silently re-auth every existing user: a spawn
    // carrying no managed env must leave the agent's credentials exactly as the CLI's
    // own on-disk login left them. Podium must add nothing.
    const h = makeHarness(settingsDir)
    const dump = await spawnAndDumpEnv(h, 'sess-native', undefined)

    expect(dump).toContain('PODIUM_SESSION_ID=sess-native') // the dump really happened
    expect(dump).not.toContain('ANTHROPIC_API_KEY=')
    expect(dump).not.toContain(CREDENTIAL)
  })

  it('an oauth credential rides the same path as CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const db = openAccountsDatabase()
    const accounts = new AccountsRepository(db)
    accounts.upsert({
      id: 'managed:claude-oauth',
      provider: 'anthropic',
      kind: 'oauth',
      credential: 'oat-test-1',
      identity: 'oat…t-1',
      scope: 'role',
      createdAt: 1,
    })
    const { env } = resolveAccountEnv(accounts, 'managed:claude-oauth')
    db.close()
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-test-1' })

    const h = makeHarness(settingsDir)
    const dump = await spawnAndDumpEnv(h, 'sess-oauth', env)

    expect(dump).toContain('CLAUDE_CODE_OAUTH_TOKEN=oat-test-1')
    expect(dump).not.toContain('ANTHROPIC_API_KEY=') // oauth must not also set the api-key var
  })
})
