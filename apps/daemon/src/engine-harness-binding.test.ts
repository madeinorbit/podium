/**
 * ENGINES, ADMISSION AND NATIVE ATTACH READ THE SESSION'S HARNESS CONTEXT
 * (POD-6546, docs/design/harness-access-contract.md §3.3/§3.4).
 *
 * The incident machine: a GUI-launched daemon whose own PATH does not hold the
 * harness, while the inventory found and verified it elsewhere. Every test
 * here puts a FAILING DECOY first on the daemon's ambient PATH — a `codex`,
 * `grok`, … that reports a version below every floor and leaves a sentinel
 * when run — and selects an installation that lives somewhere else. Anything
 * that still asks the daemon's PATH for a harness by name runs the decoy.
 *
 *   1. Server-mode admission (Codex app-server, Grok ACP) probes the selected
 *      installation and admits it; the decoy never runs.
 *   2. Version verdicts are cached per installation: a verdict for install A
 *      never vouches for install B.
 *   3. Each of the five engine families launches the selected absolute path,
 *      and the engine child's PATH comes from the context's command env, not
 *      from the daemon's own.
 *   4. A session keeps its context across an inventory refresh; a new session
 *      gets the new installation.
 *   5. Native attach spawns the session's executable over the context env.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  AGENT_MANIFESTS,
  type DriverId,
  manifestFor,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import {
  type CodexJournalEntry,
  claudeEngineFacts,
  codexEngineFacts,
  createClaudeEngineHost,
  createCodexEngineHost,
  createGrokEngineHost,
  createOpencodeEngineHost,
  type GrokAcpJournalEntry,
  grokEngineFacts,
  type OpencodeJournalEntry,
  opencode2Flavor,
  opencodeFlavor,
} from '@podium/harness/driver/host'
import { createTestEngineOwner, testHarnessContext } from '@podium/harness/driver/testing'
import { asSessionId, type SessionId } from '@podium/model'
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'
import { launchServerDriverSession } from './control/session'
import { DaemonHarnessRuntime } from './harness-runtime'
import { engineEnvBuilder } from './runtime/host'
import { createOpencodeClientTerminals } from './runtime/opencode-attach'
import { resetCodexAppServerVersionProbe, resetGrokAcpVersionProbe } from './runtime/version-probe'
import type { ClientProcessOwner } from './session/clients.js'
import { SessionRegistry } from './session/registry.js'
import * as sessionContexts from './session-harness-context'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

let root: string
let decoyBin: string
let decoySentinel: string
let ambientPath: string | undefined

/** The version each fake prints: decoys sit below every floor. */
const DECOY_VERSION: Record<string, string> = {
  codex: 'codex-cli 0.0.1',
  grok: 'grok 0.0.1',
  claude: '0.0.1 (Claude Code)',
  opencode: '0.0.1',
  opencode2: '0.0.1',
}
const SELECTED_VERSION: Record<string, string> = {
  codex: 'codex-cli 0.162.0',
  grok: 'grok 1.0.46',
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A real executable at `<dir>/<name>` that prints `version`. */
function install(dir: string, name: string, version: string): string {
  mkdirSync(dir, { recursive: true })
  return script(join(dir, name), `echo "${version}"`)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-6546-'))
  decoyBin = join(root, 'decoy', 'bin')
  decoySentinel = join(root, 'decoy-ran')
  mkdirSync(decoyBin, { recursive: true })
  for (const [name, version] of Object.entries(DECOY_VERSION)) {
    script(join(decoyBin, name), `echo "$0" >> "${decoySentinel}"\necho "${version}"`)
  }
  ambientPath = process.env.PATH
  process.env.PATH = [decoyBin, ambientPath].filter(Boolean).join(delimiter)
})

afterAll(() => {
  if (ambientPath === undefined) delete process.env.PATH
  else process.env.PATH = ambientPath
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  resetCodexAppServerVersionProbe()
  resetGrokAcpVersionProbe()
  vi.restoreAllMocks()
})

/** An inventory generation whose `kind` is `path`, unverified (`version`
 *  absent) so admission must run the selected binary itself. */
function generation(
  paths: Partial<Record<BuiltinHarnessKind, string>>,
  number: number,
  versions: Partial<Record<BuiltinHarnessKind, string>> = {},
): ResolvedHarnessInventory {
  const base = testHarnessSnapshot(paths, number)
  const executables = new Map(base.executables)
  for (const [kind, path] of Object.entries(paths) as [BuiltinHarnessKind, string][]) {
    const version = versions[kind]
    executables.set(kind, { kind, path, generation: number, ...(version ? { version } : {}) })
  }
  return {
    ...base,
    executables,
    // The recovered command environment: it does NOT hold the decoy.
    commandEnvironment: { ...base.commandEnvironment, env: { PATH: '/usr/bin:/bin', HOME: root } },
  }
}

/** A daemon context with a real inventory runtime over `builds`, and an agent
 *  runtime that records every create. */
function daemon(builds: ResolvedHarnessInventory[], harness: 'codex' | 'grok') {
  const sent: DaemonMessage[] = []
  const create = vi.fn(async (_spec: unknown, _sessionId: string) => {})
  const harnessRuntime = new DaemonHarnessRuntime({
    buildSnapshot: async (number) => builds[Math.min(number, builds.length - 1)]!,
  })
  const ctx = {
    machineId: 'machine-6546',
    send: (message: DaemonMessage) => {
      sent.push(message)
    },
    harnessLoginState: () => 'in',
    harnessRuntime,
    homeDir: join(root, 'agent-home'),
    sessions: new SessionRegistry(),
    agentRuntime: {
      resolveDriver: (input: { available: DriverId[]; requested: DriverId }) => ({
        ok: true,
        driverId: AGENT_MANIFESTS[harness].runtime.select({
          auth: 'subscription',
          platform: 'linux',
          available: input.available,
          preference: input.requested,
        }),
        capabilities: { placement: 'dedicated' },
      }),
      resumesAtLaunch: () => false,
      serverHandleFor: () => undefined,
      handleFor: () => undefined,
      adoptJournalled: async () => ({ found: false }),
      create,
    },
  } as unknown as DaemonContext
  return { ctx, sent, create, harnessRuntime }
}

async function spawn(ctx: DaemonContext, sessionId: string, harness: string, driver: string) {
  await launchServerDriverSession(ctx, {
    type: 'spawn',
    sessionId,
    agentKind: harness,
    cwd: root,
    geometry: { cols: 80, rows: 24 },
    requestedDriverId: driver,
  } as never)
}

const spawnErrors = (sent: DaemonMessage[]) =>
  sent.filter((message) => message.type === 'spawnError')

const contextOf = (call: unknown[] | undefined) =>
  (call?.[0] as { harnessContext?: { installation: { executable: string } } } | undefined)
    ?.harnessContext?.installation.executable

describe('server-mode admission probes the selected installation, never the daemon PATH', () => {
  it.each([
    ['codex', 'codex-app-server'],
    ['grok', 'grok-acp'],
  ] as const)('%s: admits the selected binary while a failing decoy is first on PATH', async (harness, driver) => {
    const selected = install(
      join(root, `selected-${harness}`, 'bin'),
      harness,
      SELECTED_VERSION[harness]!,
    )
    const { ctx, sent, create } = daemon([generation({ [harness]: selected }, 0)], harness)

    await spawn(ctx, `admit-${harness}`, harness, driver)

    expect(spawnErrors(sent)).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
    expect(contextOf(create.mock.calls[0])).toBe(selected)
    expect(existsSync(decoySentinel)).toBe(false)
  })

  it('takes a version the inventory already verified without running anything', async () => {
    // The selected path does not even exist: a verified version needs no probe.
    const selected = join(root, 'verified-only', 'bin', 'codex')
    const { ctx, sent, create } = daemon(
      [generation({ codex: selected }, 0, { codex: SELECTED_VERSION.codex })],
      'codex',
    )

    await spawn(ctx, 'admit-verified', 'codex', 'codex-app-server')

    expect(spawnErrors(sent)).toEqual([])
    expect(contextOf(create.mock.calls[0])).toBe(selected)
    expect(existsSync(decoySentinel)).toBe(false)
  })
})

describe('version verdicts are cached per installation', () => {
  it('a verdict for install A does not admit install B', async () => {
    const a = install(join(root, 'install-a', 'bin'), 'codex', SELECTED_VERSION.codex!)
    const b = install(join(root, 'install-b', 'bin'), 'codex', DECOY_VERSION.codex!)
    const { ctx, sent, create, harnessRuntime } = daemon(
      [generation({ codex: a }, 0), generation({ codex: b }, 1)],
      'codex',
    )
    const previous = process.env.PATH
    try {
      // Whichever way a probe finds its binary, each spawn can only find the
      // one its generation selected.
      process.env.PATH = join(root, 'install-a', 'bin')
      await spawn(ctx, 'cache-a', 'codex', 'codex-app-server')
      expect(spawnErrors(sent)).toEqual([])
      expect(create).toHaveBeenCalledTimes(1)

      await harnessRuntime.refresh()
      process.env.PATH = join(root, 'install-b', 'bin')
      await spawn(ctx, 'cache-b', 'codex', 'codex-app-server')
    } finally {
      process.env.PATH = previous
    }
    // B is below the floor: refused, on B's own verdict.
    expect(create).toHaveBeenCalledTimes(1)
    expect(spawnErrors(sent)).toEqual([
      expect.objectContaining({ sessionId: 'cache-b', message: expect.stringContaining('0.0.1') }),
    ])
  })
})

describe('a session keeps its context across an inventory refresh', () => {
  it('the running session keeps its installation; a new session gets the new one', async () => {
    const first = join(root, 'pin-first', 'bin', 'codex')
    const second = join(root, 'pin-second', 'bin', 'codex')
    const { ctx, create, harnessRuntime } = daemon(
      [
        generation({ codex: first }, 0, { codex: SELECTED_VERSION.codex }),
        generation({ codex: second }, 1, { codex: SELECTED_VERSION.codex }),
      ],
      'codex',
    )

    await spawn(ctx, 'pin-running', 'codex', 'codex-app-server')
    await harnessRuntime.refresh()
    await spawn(ctx, 'pin-new', 'codex', 'codex-app-server')

    expect(contextOf(create.mock.calls[0])).toBe(first)
    expect(contextOf(create.mock.calls[1])).toBe(second)
    // The running session's context is held with it, so an engine relaunch
    // (wake, adopt) launches what it was spawned with.
    expect(
      ctx.sessions.get(asSessionId('pin-running'))?.harnessContext?.installation.executable,
    ).toBe(first)
    const engineContext = (
      sessionContexts as unknown as Record<
        string,
        | ((
            ctx: DaemonContext,
            sessionId: SessionId,
            kind: BuiltinHarnessKind,
            driverId: string,
          ) => Promise<{ installation: { executable: string } }>)
        | undefined
      >
    ).engineSessionHarnessContext
    expect(typeof engineContext).toBe('function')
    const running = await engineContext?.(
      ctx,
      asSessionId('pin-running'),
      'codex',
      'codex-app-server',
    )
    expect(running?.installation.executable).toBe(first)
    const fresh = await engineContext?.(
      ctx,
      asSessionId('pin-adopted'),
      'codex',
      'codex-app-server',
    )
    expect(fresh?.installation.executable).toBe(second)
  })
})

/** Every engine spawn the session owner was asked for; each one then fails,
 *  which is all these tests need. */
function recordingOwner<T extends { sessionId: SessionId }>() {
  const started: { cmd: string; args: readonly string[]; env: Record<string, string> }[] = []
  const owner = createTestEngineOwner<T>({
    startEngine: async (req) => {
      started.push({ cmd: req.cmd, args: req.args, env: { ...req.env } })
      throw new Error('recorded')
    },
  })
  return { owner, started }
}

const SELECTED_DIR = '/opt/selected/bin'
const COMMAND_PATH = `${SELECTED_DIR}:/usr/bin:/bin`
const resources = () => undefined
const stageAttachment = async () => {
  throw new Error('unused')
}

function selectedContext(kind: BuiltinHarnessKind, name: string = kind) {
  return testHarnessContext({
    kind,
    home: '/home/agent-6546',
    executable: `${SELECTED_DIR}/${name}`,
    version: '9.9.9',
    env: { PATH: COMMAND_PATH, CONTEXT_MARK: 'command-env' },
  })
}

/**
 * The five engine families, each launched once with a selected context. The
 * env builder is the daemon's own (`engineEnvBuilder`); version admission is
 * waved through here (it has its own tests above).
 */
const families: {
  name: string
  context: ReturnType<typeof selectedContext>
  launch(context: ReturnType<typeof selectedContext>): Promise<{
    cmd: string
    env: Record<string, string>
  }>
}[] = [
  {
    name: 'codex app-server',
    context: selectedContext('codex'),
    async launch(context) {
      const { owner, started } = recordingOwner<CodexJournalEntry>()
      const facts = codexEngineFacts(manifestFor('codex')!)
      const host = createCodexEngineHost({
        facts,
        engines: owner,
        stageAttachment,
        resources,
        buildEnv: engineEnvBuilder(() => ({})),
        gracefulExitMs: 50,
        checkVersion: async () => ({ drivable: true }),
        dialSocket: async () => {
          throw new Error('unused')
        },
        harnessContextFor: async () => context,
      } as never)
      await host
        .launch({
          sessionId: asSessionId('engine-codex'),
          workdir: root,
          harnessContext: context,
        } as never)
        .catch(() => {})
      return started[0]!
    },
  },
  {
    name: 'grok acp',
    context: selectedContext('grok'),
    async launch(context) {
      const { owner, started } = recordingOwner<GrokAcpJournalEntry>()
      const host = createGrokEngineHost({
        facts: grokEngineFacts(manifestFor('grok')!),
        engines: owner,
        resources,
        buildEnv: engineEnvBuilder(() => ({})),
        gracefulExitMs: 50,
        checkVersion: async () => ({ drivable: true }),
        harnessContextFor: async () => context,
      } as never)
      await host
        .launch({
          sessionId: asSessionId('engine-grok'),
          workdir: root,
          harnessContext: context,
        } as never)
        .catch(() => {})
      return started[0]!
    },
  },
  {
    name: 'claude stream',
    context: selectedContext('claude-code', 'claude'),
    async launch(context) {
      const { owner, started } = recordingOwner<{ sessionId: SessionId }>()
      const manifest = manifestFor('claude-code')!
      const host = createClaudeEngineHost({
        facts: claudeEngineFacts({ kind: manifest.kind, inventory: manifest.inventory }),
        engines: owner,
        buildEnv: engineEnvBuilder(() => ({})),
        gracefulExitMs: 50,
        harnessContextFor: async () => context,
      } as never)
      const turn = host.startTurn({
        sessionId: asSessionId('engine-claude'),
        spec: {
          harness: 'claude-code',
          harnessContext: context,
          workdir: root,
          model: {},
          instructions: { supported: false, reason: 'fixture' },
          mcpServers: { supported: false, reason: 'fixture' },
        },
        turn: { text: 'hello' },
        resumeValue: 'resume-1',
        newConversation: true,
        userMessageUuid: '0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e70',
        onPartialText: () => {},
        onPermission: () => {},
      } as never)
      await turn.done.catch(() => {})
      return started[0]!
    },
  },
  {
    name: 'opencode serve',
    context: selectedContext('opencode'),
    async launch(context) {
      const { owner, started } = recordingOwner<OpencodeJournalEntry>()
      const flavor = opencodeFlavor(manifestFor('opencode')!)
      const host = createOpencodeEngineHost({
        flavor,
        engines: owner,
        stageAttachment,
        resources,
        buildEnv: engineEnvBuilder(() => ({})),
        gracefulExitMs: 50,
        checkVersion: async () => null,
        harnessContextFor: async () => context,
      } as never)
      await host
        .launch({
          sessionId: asSessionId('engine-opencode'),
          workdir: root,
          secret: 'secret',
          username: 'podium',
          harnessContext: context,
        } as never)
        .catch(() => {})
      return started[0]!
    },
  },
  {
    name: 'opencode2 serve',
    context: selectedContext('opencode', 'opencode2'),
    async launch(context) {
      const { owner, started } = recordingOwner<OpencodeJournalEntry>()
      const flavor = opencode2Flavor(manifestFor('opencode')!)
      const host = createOpencodeEngineHost({
        flavor,
        engines: owner,
        stageAttachment,
        resources,
        buildEnv: engineEnvBuilder(() => ({})),
        gracefulExitMs: 50,
        checkVersion: async () => null,
        harnessContextFor: async () => context,
      } as never)
      await host
        .launch({
          sessionId: asSessionId('engine-opencode2'),
          workdir: root,
          secret: 'secret',
          username: 'opencode',
          harnessContext: context,
        } as never)
        .catch(() => {})
      return started[0]!
    },
  },
]

describe('every engine family launches the session context', () => {
  it.each(families)('$name: argv[0] is the selected absolute path', async (family) => {
    const started = await family.launch(family.context)
    expect(started?.cmd).toBe(family.context.installation.executable)
  })

  it.each(
    families,
  )("$name: the child's PATH comes from the command env, not the daemon's", async (family) => {
    const previous = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    let started: Awaited<ReturnType<(typeof families)[number]['launch']>> | undefined
    try {
      started = await family.launch(family.context)
    } finally {
      process.env.PATH = previous
    }
    expect(started?.env.PATH?.split(delimiter)).toContain(SELECTED_DIR)
    expect(started?.env.CONTEXT_MARK).toBe('command-env')
  })
})

describe('native attach spawns the session context', () => {
  it.each([
    [
      'codex',
      selectedContext('codex'),
      {
        kind: 'codex',
        conversation: 'thread-1',
        endpoint: { address: 'unix:///run/codex.sock' },
        workdir: '/work',
      },
    ],
    [
      'grok',
      selectedContext('grok'),
      { kind: 'grok', conversation: 'grok-1', endpoint: {}, workdir: '/work' },
    ],
    [
      'opencode',
      selectedContext('opencode'),
      {
        kind: 'opencode',
        conversation: 'ses_1',
        endpoint: { address: 'http://127.0.0.1:4100', username: 'podium', secret: 's' },
        workdir: '/work',
      },
    ],
  ] as const)('%s: the client runs the selected path over the context env', async (_kind, context, target) => {
    const sessionId = asSessionId(`attach-${target.kind}`)
    const sessions = new SessionRegistry()
    sessions.ensure(sessionId).harnessContext = context
    const spawns: { cmd: string; env?: Record<string, string> }[] = []
    const clients: ClientProcessOwner = {
      spawnClient: async (opts) => {
        spawns.push({ cmd: opts.cmd, ...(opts.env ? { env: opts.env } : {}) })
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
    } as never)
    await terminals.attach({ sessionId, target: target as never }).catch(() => {})

    expect(spawns[0]?.cmd).toBe(context.installation.executable)
    expect(spawns[0]?.env?.CONTEXT_MARK).toBe('command-env')
    expect(spawns[0]?.env?.PATH?.split(delimiter)).toContain(SELECTED_DIR)
    expect(existsSync(decoySentinel)).toBe(false)
  })
})
