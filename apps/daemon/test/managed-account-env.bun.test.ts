// apps/daemon/test/managed-account-env.bun.test.ts
//
// RUNNER: bun test only (`bun run test:bun`).
//
// The managed-credential spawn path (#216) has a vitest integration twin in
// scripts/managed-account-spawn.integration.test.ts, but vitest runs under NODE — so it
// exercises the node-pty backend. The SHIPPED daemon is bun-compiled and therefore uses
// the Bun.Terminal PTY backend (a compiled daemon has no node-pty fallback at all — see
// packages/pty/src/backends/index.ts). Env is handed to the OS by the BACKEND, so the
// backend the users actually run must be proven too, not just the one the test runner picks.
//
// Same two directions as the vitest twin, against a real process's real environment:
//   POSITIVE — a credential on the spawn frame reaches the child's environ.
//   NEGATIVE — a spawn with no env injects no ANTHROPIC_API_KEY (the silent-re-auth
//              regression that would change every existing native-account user's auth).
// POD-2296 adds the third direction, which the first two cannot see because they
// run with a clean ambient env:
//   STRIP    — a key the DAEMON carries is deleted from an agent child's environ,
//              kept for a shell, and never confused with the one on the frame.
//
// Reaps by explicit pid. Never pattern-kills — a `pkill` here could take out the
// developer's live agent sessions.

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand } from '@podium/harness'
import type { HarnessAgent } from '@podium/model'
import { SpawnMessage } from '@podium/protocol'
import { hasBunTerminal } from '@podium/pty'
import { credentialEnv } from '@podium/runtime'
import type { DaemonContext } from '../src/control/context'
import { launchSpawn } from '../src/control/session'

const CREDENTIAL = 'sk-test-xyz'
/** A key on the DAEMON, standing in for one an operator exported before starting it. */
const INHERITED_KEY = 'sk-test-inherited-from-the-daemon'
const HARNESS_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CODEX_HOME',
  'GROK_HOME',
  'PODIUM_TEST_REQUIRED_ENV',
] as const

let settingsDir: string
let home: string
let savedHome: string | undefined
let savedShell: string | undefined
let savedKey: string | undefined
let savedHarnessEnv: Record<(typeof HARNESS_ENV_KEYS)[number], string | undefined>

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'podium-bun-spawn-settings-'))
  home = mkdtempSync(join(tmpdir(), 'podium-bun-spawn-home-'))
  savedHome = process.env.HOME
  savedShell = process.env.SHELL
  savedKey = process.env.ANTHROPIC_API_KEY
  savedHarnessEnv = Object.fromEntries(
    HARNESS_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as typeof savedHarnessEnv
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
  for (const key of HARNESS_ENV_KEYS) {
    const value = savedHarnessEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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
 *  own `env` wrote to a landing file. `env` (not `echo $VAR`) reports the
 *  process's actual environ, and the parent only reads the child's artifact.
 *
 *  `agentKind` is the kind the FRAME declares — the daemon composes the env for
 *  that harness — while the process launched is always a shell, because a shell is
 *  the only child that will tell us its own environ. The strip decision is made
 *  from the frame's kind, so this substitution changes nothing it depends on. */
async function dumpEnvOfSpawnedProcess(
  sessionId: string,
  env: Record<string, string> | undefined,
  agentKind: 'shell' | HarnessAgent = 'shell',
): Promise<string> {
  let buffer = ''
  const landing = join(home, `${sessionId}.env`)
  const bridges = new Map<string, { pid: number; write(b64: string): void; dispose(): void }>()
  const ctx = {
    send: () => {},
    instanceId: 'default',
    homeDir: home,
    backend: 'none', // bare PTY child: no abduco/tmux master can outlive this test
    // A harness frame still launches a shell (see above). `-c` so the harness's
    // own instrumentation args, appended by the daemon, land as ignored
    // positional parameters instead of confusing bash.
    launch: (kind: string, opts: { cwd: string }) =>
      kind === 'shell'
        ? agentLaunchCommand(kind, opts as Parameters<typeof agentLaunchCommand>[1])
        : { cmd: '/bin/bash', args: ['-c', 'exec /bin/bash -i'], cwd: opts.cwd },
    settingsDir,
    bridges,
    durableLabels: new Map(),
    durableLabelFor: (id: string) => `podium-${id}`,
    bindingStore: {
      ensureBinding: async () => ({}),
      observe: async () => ({}),
      retire: async () => ({}),
    },
    // The spawn path refuses a frame with no server-minted binding, and applies
    // it before composing any env. Stubbed to 'applied' so this file keeps
    // testing the environment rather than the authority gate, which
    // `session-binding.test.ts` owns.
    machineId: 'bun-spawn-test-machine',
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    pendingResizes: new Map(),
    composerEngine: {
      attach: () => false,
      onData: () => {},
      detach: () => {},
      has: () => false,
    },
    outputScheduler: {
      enqueue: (_id: string, data: string) => {
        buffer += Buffer.from(data, 'base64').toString('utf8')
      },
      remove: () => {},
    },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext

  // The real wire frame through the real schema.
  const msg = SpawnMessage.parse({
    type: 'spawn',
    sessionId,
    agentKind,
    runtimeContract: 'generic-pty',
    cwd: process.cwd(),
    geometry: { cols: 120, rows: 30 },
    binding: {
      transitionId: `transition-${sessionId}`,
      machineAccess: 'allowed',
      principal: { kind: 'system', job: 'managed-account-env-test' },
    },
    ...(env ? { env } : {}),
  })
  // The environment contract lives at the terminal launch boundary. Server
  // admission is orthogonal and has its own process-level coverage.
  await launchSpawn(ctx, msg, { handled: false })
  // The handler dispatches the launch and returns; the bridge appears when the
  // PTY is up, an await or two later. Wait for it rather than racing it.
  await waitFor(() => bridges.has(sessionId)).catch(() => {
    throw new Error('daemon never bridged the session (spawn failed)')
  })

  const session = bridges.get(sessionId)
  if (!session) throw new Error('daemon never bridged the session (spawn failed)')
  const pid = session.pid
  try {
    await waitFor(() => buffer.length > 0)
    session.write(Buffer.from(`env > ${JSON.stringify(landing)}\n`, 'utf8').toString('base64'))
    // PODIUM_SESSION_ID is bound by the daemon on EVERY spawn: seeing it proves the dump
    // really landed and that this process came out of Podium's spawn path — which is what
    // makes the credential's ABSENCE in the negative case meaningful rather than just early.
    await waitFor(
      () =>
        existsSync(landing) &&
        readFileSync(landing, 'utf8').includes(`PODIUM_SESSION_ID=${sessionId}`),
    )
    return readFileSync(landing, 'utf8')
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

it("STRIP: the daemon's own ANTHROPIC_API_KEY never reaches a claude session", async () => {
  // POD-2296. The daemon hands every child its own environment, so a key exported
  // in the shell that started it — or in its unit file — is inherited by the agent
  // and beats the subscription the agent home is logged into. Claude Code then
  // bills that key's account and says so only in a banner nobody re-reads.
  process.env.ANTHROPIC_API_KEY = INHERITED_KEY

  const dump = await dumpEnvOfSpawnedProcess('bun-inherited', undefined, 'claude-code')

  expect(dump).toContain('PODIUM_SESSION_ID=bun-inherited') // the dump really happened
  expect(dump).not.toContain(INHERITED_KEY)
  expect(dump).not.toContain('ANTHROPIC_API_KEY=')
})

it('ISOLATION: parent Claude controls are absent while ordinary daemon env still arrives', async () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '1'
  process.env.CLAUDE_CODE_SESSION_ID = 'parent-session-id'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'parent-entrypoint'
  process.env.CLAUDE_CODE_EXECPATH = '/parent/claude'
  process.env.PODIUM_TEST_REQUIRED_ENV = 'machine-setting-the-agent-needs'

  const dump = await dumpEnvOfSpawnedProcess('bun-claude-isolated', undefined, 'claude-code')

  expect(dump).toContain('PODIUM_SESSION_ID=bun-claude-isolated')
  expect(dump).toContain('PODIUM_TEST_REQUIRED_ENV=machine-setting-the-agent-needs')
  for (const key of HARNESS_ENV_KEYS.slice(0, 4)) expect(dump).not.toContain(`${key}=`)
})

it('ISOLATION: Codex state follows the named instance instead of the daemon selector', async () => {
  process.env.CODEX_HOME = '/daemon-parent/.codex'

  const dump = await dumpEnvOfSpawnedProcess(
    'bun-codex-home',
    { PODIUM_TEST_REQUIRED_ENV: 'codex-managed-value' },
    'codex',
  )

  expect(dump).toContain('PODIUM_TEST_REQUIRED_ENV=codex-managed-value')
  expect(dump).toContain('PODIUM_SESSION_ID=bun-codex-home')
  expect(dump).toContain(`CODEX_HOME=${join(home, '.codex')}`)
  expect(dump).not.toContain('CODEX_HOME=/daemon-parent/.codex')
})

it('ISOLATION: Grok state follows the named instance instead of the daemon selector', async () => {
  process.env.GROK_HOME = '/daemon-parent/.grok'

  const dump = await dumpEnvOfSpawnedProcess(
    'bun-grok-home',
    { PODIUM_TEST_REQUIRED_ENV: 'grok-managed-value' },
    'grok',
  )

  expect(dump).toContain('PODIUM_TEST_REQUIRED_ENV=grok-managed-value')
  expect(dump).toContain('PODIUM_SESSION_ID=bun-grok-home')
  expect(dump).toContain(`GROK_HOME=${join(home, '.grok')}`)
  expect(dump).not.toContain('GROK_HOME=/daemon-parent/.grok')
})

it('STRIP: a managed credential still reaches the child that the daemon key does not', async () => {
  // The two are the same variable and must not share a fate: one is the account
  // Podium resolved for this session, the other is a leak from the host.
  process.env.ANTHROPIC_API_KEY = INHERITED_KEY

  const dump = await dumpEnvOfSpawnedProcess(
    'bun-managed-over-inherited',
    { ANTHROPIC_API_KEY: CREDENTIAL },
    'claude-code',
  )

  expect(dump).toContain(`ANTHROPIC_API_KEY=${CREDENTIAL}`)
  expect(dump).not.toContain(INHERITED_KEY)
})

it("STRIP: an operator's shell keeps the key they exported themselves", async () => {
  // The line this fix draws: a shell session is the operator at their own prompt,
  // not an agent resolving an account. Taking their key out of their own terminal
  // would break work they meant to do.
  process.env.ANTHROPIC_API_KEY = INHERITED_KEY

  const dump = await dumpEnvOfSpawnedProcess('bun-operator-shell', undefined)

  expect(dump).toContain(`ANTHROPIC_API_KEY=${INHERITED_KEY}`)
})

it("PRESERVE: an operator's shell keeps harness variables they exported", async () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '1'
  process.env.CLAUDE_CODE_SESSION_ID = 'operator-shell-session'
  process.env.CODEX_HOME = '/operator/chosen/.codex'

  const dump = await dumpEnvOfSpawnedProcess('bun-shell-harness-env', undefined)

  expect(dump).toContain('CLAUDE_CODE_CHILD_SESSION=1')
  expect(dump).toContain('CLAUDE_CODE_SESSION_ID=operator-shell-session')
  expect(dump).toContain('CODEX_HOME=/operator/chosen/.codex')
  expect(dump).toContain('PODIUM_SESSION_ID=bun-shell-harness-env')
})
