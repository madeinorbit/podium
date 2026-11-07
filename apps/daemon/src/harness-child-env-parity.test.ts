// ONE CHILD ENVIRONMENT, FIVE SPAWN PATHS (POD-6535, design §3.5).
//
// For the same inputs — one inventory snapshot, one account home, one harness —
// the terminal, engine, headless-turn, buffered-exec and attach-client paths
// must hand their child the same environment, apart from each path's
// documented overlay:
//
//   terminal  Podium's session process env (relay pair, BROWSER, and the
//             shim's folder as a PATH prefix)
//   engine    the same, plus PODIUM_SESSION_ID / PODIUM_INSTANCE_UUID stamps
//   headless  the same (the `sessionEnv` port's instance env)
//   buffered  nothing: the old-peer frame carries no Podium session
//   attach    PODIUM_SESSION_ID / PODIUM_INSTANCE_UUID stamps
//
// plus whatever the adapter puts in its own invocation env (none, for the
// codex invocations below). Codex is the one harness all five paths launch.
//
// Each path is driven through the daemon's own composition. The headless path
// is the host-runtime port's two lines (context over the snapshot, then
// `headlessTurnChildEnv`), which live inline in the runtime wiring.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessContext, type ResolvedHarnessInventory } from '@podium/harness'
import { asSessionId, type SessionId } from '@podium/model'
import type { SpawnOptions } from '@podium/process/screen'
import { afterAll, describe, expect, it } from 'vitest'
import { type BufferedHarnessRequest, executeBufferedHarnessTurn } from './buffered-harness.js'
import type { DaemonContext } from './control/context'
import { sessionProcessEnv } from './control/session.js'
import { headlessTurnChildEnv } from './control/session-env.js'
import { DaemonHarnessRuntime } from './harness-runtime.js'
import { engineEnvBuilder } from './runtime/host.js'
import { createOpencodeClientTerminals } from './runtime/opencode-attach.js'
import type { ClientProcessOwner } from './session/clients.js'
import { SessionRegistry } from './session/registry.js'
import { stubDurable, testSessions, testTerminalRuntime } from './session/testing.js'
import { driverHarnessContextFrom } from './session-harness-context.js'
import { testHarnessSnapshot } from './test-support/harness-snapshot.js'

const settingsDir = mkdtempSync(join(tmpdir(), 'podium-env-parity-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

const ACCOUNT_HOME = '/state/agent-home'
const CLI = '/Applications/Podium.app/Contents/Resources/resources/podium'

/** One inventory generation whose command env carries everything a daemon
 *  started from a developer's shell inside a Claude session would. */
function snapshot(): ResolvedHarnessInventory {
  const base = testHarnessSnapshot()
  return {
    ...base,
    commandEnvironment: {
      ...base.commandEnvironment,
      env: Object.freeze({
        PATH: '/opt:/usr/bin:/bin',
        HOME: '/home/operator',
        MARK: 'command-env',
        CODEX_HOME: '/home/operator/.codex',
        OPENAI_API_KEY: 'sk-inherited',
        PODIUM_CLI_PATH: CLI,
      }),
      machineHome: '/home/operator',
    },
  }
}

const daemonFacts = {
  instanceId: 'default',
  instanceUuid: 'uuid-parity',
  settingsDir,
  homeDir: ACCOUNT_HOME,
  agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
}

/** Keys a path's documented overlay may add (see the header). */
const isPodiumOverlay = (key: string) =>
  (key.startsWith('PODIUM_') && key !== 'PODIUM_CLI_PATH') || key === 'BROWSER'

/** The browser shim's folder: the one PATH entry a Podium overlay adds. */
const shimDir = join(settingsDir, 'browser-shims')

function common(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !isPodiumOverlay(key)))
  if (out.PATH !== undefined)
    out.PATH = out.PATH.split(':')
      .filter((entry) => entry !== shimDir)
      .join(':')
  return out
}

function atBoundary(env: Record<string, string | undefined>, strip: readonly string[] = []) {
  const out = { ...env }
  for (const key of strip) delete out[key]
  return out
}

async function terminalEnv(sessionEnv?: Record<string, string>) {
  let captured: SpawnOptions | undefined
  const fakeSpawn = (opts: SpawnOptions) => {
    captured = opts
    return {
      pid: 4242,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: () => () => {},
      write: () => {},
      resize: () => {},
      dispose: () => {},
    }
  }
  const { launchTerminalProcess, sessionHandlers } = await import('./control/session')
  const S = snapshot()
  const ctx = {
    ...daemonFacts,
    send: () => {},
    backend: 'none',
    durable: stubDurable(fakeSpawn),
    machineId: 'parity-machine',
    harnessRuntime: new DaemonHarnessRuntime({ buildSnapshot: async () => S }),
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: { enqueue: () => {}, remove: () => {} },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
  } as unknown as DaemonContext
  ctx.agentRuntime = testTerminalRuntime(
    ctx,
    launchTerminalProcess,
  ) as unknown as DaemonContext['agentRuntime']
  await sessionHandlers.spawn(ctx, {
    type: 'spawn',
    sessionId: 'parity-terminal',
    agentKind: 'codex',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: 'parity-transition',
      machineAccess: 'allowed',
      principal: { kind: 'system', job: 'env-parity-test' },
    },
    ...(sessionEnv ? { env: sessionEnv } : {}),
  } as Parameters<typeof sessionHandlers.spawn>[1])
  const start = Date.now()
  while (!captured && Date.now() - start < 5_000) await new Promise((r) => setTimeout(r, 10))
  if (!captured) throw new Error('the terminal never reached the PTY layer')
  return atBoundary(captured.env ?? {}, captured.stripEnv)
}

function engineEnv(sessionEnv?: Record<string, string>) {
  const S = snapshot()
  // The builder host-runtime hands every engine family.
  return engineEnvBuilder((sessionId, agentKind) =>
    sessionProcessEnv(daemonFacts, sessionId, agentKind),
  )({
    sessionId: asSessionId('parity-engine'),
    agentKind: 'codex',
    harnessContext: driverHarnessContextFrom(daemonFacts, S, 'codex', undefined),
    ...(sessionEnv ? { sessionEnv } : {}),
    instanceUuid: daemonFacts.instanceUuid,
  })
}

function headlessEnv() {
  const S = snapshot()
  const { env, strip } = headlessTurnChildEnv({
    context: driverHarnessContextFrom(daemonFacts, S, 'codex', undefined),
    // The `sessionEnv` port: Podium's session process env.
    instanceEnv: sessionProcessEnv(daemonFacts, asSessionId('parity-headless'), 'codex'),
  })
  return atBoundary(env, strip)
}

async function bufferedEnv() {
  let env: NodeJS.ProcessEnv | undefined
  const result = await executeBufferedHarnessTurn(
    { homeDir: ACCOUNT_HOME, harnessRuntime: undefined },
    {
      type: 'harnessExecRequest',
      requestId: 'parity',
      agent: 'codex',
      prompt: 'p',
    } as BufferedHarnessRequest,
    {
      snapshot: async () => snapshot(),
      runChild: async (_cmd, _args, opts) => {
        env = opts.env
        return { stdout: '' }
      },
    },
  )
  if (!result.ok) throw new Error(result.output)
  return { ...env }
}

async function attachEnv() {
  const S = snapshot()
  const context = harnessContext(S, 'codex', ACCOUNT_HOME)
  const sessionId: SessionId = asSessionId('parity-attach')
  const sessions = new SessionRegistry()
  sessions.ensure(sessionId).harnessContext = context
  let spawned: { env?: Record<string, string>; stripEnv?: readonly string[] } | undefined
  const clients: ClientProcessOwner = {
    spawnClient: async (opts) => {
      spawned = {
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.stripEnv ? { stripEnv: opts.stripEnv } : {}),
      }
      throw new Error('recorded')
    },
    reclaimClient: async () => {},
    hasClientMaster: () => false,
  }
  const terminals = createOpencodeClientTerminals({
    sessions,
    clients,
    frames: () => {},
    harnessContext: async () => context,
    homeDir: ACCOUNT_HOME,
    instanceUuid: daemonFacts.instanceUuid,
  } as never)
  await terminals
    .attach({
      sessionId,
      target: {
        kind: 'codex',
        conversation: 'thread-1',
        endpoint: { address: 'unix:///run/codex.sock' },
        workdir: '/work',
      } as never,
    })
    .catch(() => {})
  if (!spawned) throw new Error('the attach client never reached spawn')
  return atBoundary(spawned.env ?? {}, spawned.stripEnv)
}

describe('every spawn path builds the same child env', () => {
  it('terminal, engine, headless turn, buffered exec and attach agree outside their overlays', async () => {
    const envs = {
      terminal: common(await terminalEnv()),
      engine: common(engineEnv()),
      headless: common(headlessEnv()),
      buffered: common(await bufferedEnv()),
      attach: common(await attachEnv()),
    }
    // What all five must share: the account home and its selector, the
    // command env underneath, the inherited key gone, the CLI first on PATH,
    // and codex's declared compat var.
    expect(envs.terminal).toMatchObject({
      HOME: ACCOUNT_HOME,
      CODEX_HOME: `${ACCOUNT_HOME}/.codex`,
      MARK: 'command-env',
      PODIUM_CLI_PATH: CLI,
      CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1',
    })
    expect(envs.terminal.OPENAI_API_KEY).toBeUndefined()
    expect(
      envs.terminal.PATH?.startsWith('/Applications/Podium.app/Contents/Resources/resources:'),
    ).toBe(true)
    for (const [path, env] of Object.entries(envs)) {
      expect({ path, env }).toEqual({ path, env: envs.terminal })
    }
  })

  it('the two paths that carry a spawn-frame env keep its chosen key alike', async () => {
    const sessionEnv = { OPENAI_API_KEY: 'sk-chosen', PATH: '/session/bin' }
    const terminal = common(await terminalEnv(sessionEnv))
    const engine = common(engineEnv(sessionEnv))
    expect(terminal.OPENAI_API_KEY).toBe('sk-chosen')
    // The session env beats the machine env in both (POD-6535: the terminal's
    // machine env used to win).
    expect(terminal.PATH?.split(':')).toContain('/session/bin')
    expect(terminal.PATH?.split(':')).not.toContain('/opt')
    expect(engine).toEqual(terminal)
  })
})
