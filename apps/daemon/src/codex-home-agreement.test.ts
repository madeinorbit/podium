/**
 * EVERY CODEX FOLDER SITE AGREES (POD-6532, finding F07).
 *
 * Six places used to derive Codex's state folder, with five precedence orders
 * between them. Each is driven here through the entry point production calls,
 * with the home its caller holds today, and the test reads back WHICH folder it
 * touched: a distinct auth token, rollout and hooks file sit in every candidate
 * folder. In each setup all of them must name the same one.
 *
 *   (a) default: no agent home; HOME is the machine home.
 *   (b) an account (agent) home different from the machine home.
 *   (c) (b), plus a decoy CODEX_HOME in the daemon's own environment. The
 *       account's folders must not follow it: the child the session launches
 *       gets CODEX_HOME from the account home, and so does the inventory.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import {
  declaredValue,
  type HarnessContext,
  harnessAccount,
  manifestFor,
  resolvePinnedCodexRollout,
} from '@podium/harness'
import type { SessionSpec } from '@podium/harness/driver/host'
import { installTerminalInstrumentation } from '@podium/harness/driver/host'
import type { StatTick } from '@podium/harness/store'
import { type AgentQuotaWire, asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Bun snapshots os.homedir() at startup; the setups move HOME per case.
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>()
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() }
})

// The observer's sessions root is what it hands the owned-rollout resolver.
const observed = vi.hoisted(() => ({ sessionsRoots: [] as string[] }))
vi.mock('../../../packages/harness/src/adapters/codex/owned-rollout.js', async (original) => {
  const actual =
    await original<typeof import('../../../packages/harness/src/adapters/codex/owned-rollout.js')>()
  return {
    ...actual,
    createOwnedCodexRolloutResolver: (
      input: Parameters<typeof actual.createOwnedCodexRolloutResolver>[0],
    ) => {
      observed.sessionsRoots.push(input.sessionsRoot)
      return async () => undefined
    },
  }
})

import { codexAuthPathFor } from './control/codex'
import { DaemonHarnessRuntime } from './harness-runtime'
import { terminalInstrumentationSectionsFor } from './runtime/registry'
import { buildSessionHarnessContext } from './session-harness-context'
import { createSessionObservers } from './session-observers'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

type Folder = 'machine' | 'account' | 'decoy'

interface Layout {
  root: string
  machineHome: string
  accountHome: string
  folders: Record<Folder, string>
  threadId: string
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  observed.sessionsRoots.length = 0
})

function idToken(email: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ email })}.sig`
}

/** Every candidate Codex folder, each marked so a site's read names it. */
async function layout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-agreement-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const machineHome = join(root, 'machine')
  const accountHome = join(root, 'account')
  const folders: Record<Folder, string> = {
    machine: join(machineHome, '.codex'),
    account: join(accountHome, '.codex'),
    decoy: join(root, 'decoy-codex-home'),
  }
  const threadId = randomUUID()
  for (const [label, folder] of Object.entries(folders)) {
    const day = join(folder, 'sessions', '2026', '01', '01')
    await mkdir(day, { recursive: true })
    await writeFile(
      join(folder, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: `token-${label}`,
          refresh_token: 'refresh',
          id_token: idToken(`${label}@example.test`),
          account_id: `acct-${label}`,
        },
      }),
    )
    await writeFile(join(folder, 'config.toml'), '# fixture\n')
    const at = new Date().toISOString()
    await writeFile(
      join(day, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`),
      [
        {
          type: 'session_meta',
          payload: { id: threadId, cwd: '/repo', source: 'cli', timestamp: at },
        },
        { type: 'turn_context', payload: { model: 'gpt-fixture' } },
        {
          timestamp: at,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    )
  }
  return { root, machineHome, accountHome, folders, threadId }
}

function folderOf(world: Layout, path: string | undefined): Folder | 'none' {
  if (!path) return 'none'
  for (const [label, folder] of Object.entries(world.folders) as [Folder, string][]) {
    if (path === folder || path.startsWith(folder + sep)) return label
  }
  return 'none'
}

function terminalSpec(harnessContext: HarnessContext): SessionSpec {
  return {
    harness: 'codex',
    harnessContext,
    selection: { auth: 'unknown', platform: 'linux', available: [] },
    workdir: '/repo',
    model: {},
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
    instrumentation: { endpointUrl: 'http://127.0.0.1:1234/hooks/session' },
  }
}

async function observerSessionsRoot(
  homeDir: string | undefined,
  harnessContext: HarnessContext,
): Promise<string | undefined> {
  const watchers = new Set<() => void>()
  const statTick: StatTick = {
    subscribe(watcher) {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
  }
  const observers = createSessionObservers({
    send: () => {},
    statTick,
    ...(homeDir ? { homeDir } : {}),
    onTranscriptDirty: vi.fn(),
    cwdTracker: { onHookCwd: vi.fn(async () => {}) },
  })
  const sessionId = asSessionId(`agreement-${randomUUID()}`)
  const session: DurableAttachment = {
    pid: 101,
    holdsWriterLease: () => true,
    onFrame: () => () => {},
    onExit: () => () => {},
    onLeaseLost: () => () => {},
    onTitle: () => () => {},
    write() {},
    writeBytes() {},
    resize() {},
    dispose() {},
  }
  observers.initSessionObservers(
    {
      type: 'spawn',
      sessionId,
      agentKind: 'codex',
      cwd: '/repo',
      durableLabel: 'podium-fixture',
      geometry: { cols: 80, rows: 24 },
      observationGeneration: 1,
      observationBindingVersion: 1,
      observationProviderSessionId: null,
    },
    session,
    undefined,
    { seedOnFrame: false, startedAtMs: Date.now(), harnessContext },
  )
  observers.clearSession(sessionId)
  return observed.sessionsRoots.at(-1)
}

/** Drive each site the way its production caller does, with the home it holds. */
async function sitesFor(world: Layout, accountHome: string | undefined) {
  const usage = declaredValue(manifestFor('codex')!.usage)!
  const quota = declaredValue(usage.quota)!
  const transcripts = declaredValue(usage.transcripts)!

  let bearer = ''
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    bearer = init?.headers?.Authorization ?? ''
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  // The account the production fan-out hands the section (POD-6534): the
  // credential home over the command env, which copies the daemon's env.
  const account = harnessAccount('codex', accountHome ?? world.machineHome, process.env)
  const quotaResult: AgentQuotaWire = await quota.fetchQuota({ account, fetchImpl })
  expect(quotaResult.status).toBe('ok')
  const quotaFolder = (['machine', 'account', 'decoy'] as const).find(
    (label) => bearer === `Bearer token-${label}`,
  )

  const scans = await transcripts.scan({ sinceMs: 0, account })
  const scannedFolders = [...new Set(scans.map((scan) => folderOf(world, scan.path)))]

  const rollout = await resolvePinnedCodexRollout(world.threadId, accountHome ?? world.machineHome)

  // The session context, built the way a spawn builds it: the daemon's
  // credential home over the inventory's command environment, which carries
  // whatever the daemon's own environment holds (the decoy included).
  const base = testHarnessSnapshot({}, 0)
  const commandEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) commandEnv[key] = value
  }
  const snapshot = {
    ...base,
    commandEnvironment: {
      ...base.commandEnvironment,
      env: commandEnv,
      machineHome: world.machineHome,
    },
  }
  const harnessContext = await buildSessionHarnessContext(
    {
      harnessRuntime: new DaemonHarnessRuntime({ buildSnapshot: async () => snapshot }),
      homeDir: accountHome,
    },
    'codex',
  )

  const settingsDir = join(world.root, `settings-${randomUUID()}`)
  await mkdir(settingsDir)
  const sessionId = asSessionId(`hooks-${randomUUID()}`)
  const before = new Map<Folder, boolean>()
  for (const [label, folder] of Object.entries(world.folders) as [Folder, string][]) {
    before.set(label, existsSync(join(folder, 'hooks.json')))
  }
  await installTerminalInstrumentation({
    sessionId,
    harness: 'codex',
    spec: terminalSpec({
      ...harnessContext,
      installation: { ...harnessContext.installation, version: 'codex-cli 0.162.0' },
    }),
    sections: terminalInstrumentationSectionsFor('codex'),
    settingsDir,
  })
  const hooksFolders = (Object.entries(world.folders) as [Folder, string][])
    .filter(([label, folder]) => !before.get(label) && existsSync(join(folder, 'hooks.json')))
    .map(([label]) => label)
  for (const folder of Object.values(world.folders)) {
    await rm(join(folder, 'hooks.json'), { force: true })
  }

  return {
    controlAuth: folderOf(world, dirname(codexAuthPathFor(accountHome))),
    quotaAuth: quotaFolder ?? 'none',
    usageScan: scannedFolders.length === 1 ? scannedFolders[0] : scannedFolders.join('+'),
    stateProviderRollout: folderOf(world, rollout?.path),
    instrumentationHooks: hooksFolders.length === 1 ? hooksFolders[0] : hooksFolders.join('+'),
    observerSessions: folderOf(world, await observerSessionsRoot(accountHome, harnessContext)),
  }
}

function agreeing(folder: Folder) {
  return {
    controlAuth: folder,
    quotaAuth: folder,
    usageScan: folder,
    stateProviderRollout: folder,
    instrumentationHooks: folder,
    observerSessions: folder,
  }
}

describe('every Codex folder site resolves the same folder', () => {
  it('(a) default home: all sites use <machine home>/.codex', async () => {
    const world = await layout()
    vi.stubEnv('HOME', world.machineHome)
    vi.stubEnv('CODEX_HOME', undefined)
    expect(await sitesFor(world, undefined)).toEqual(agreeing('machine'))
  })

  it('(b) an account home different from the machine home: all sites use the account', async () => {
    const world = await layout()
    vi.stubEnv('HOME', world.machineHome)
    vi.stubEnv('CODEX_HOME', undefined)
    expect(await sitesFor(world, world.accountHome)).toEqual(agreeing('account'))
  })

  it("(c) a decoy CODEX_HOME in the daemon's own env redirects none of the account's sites", async () => {
    const world = await layout()
    vi.stubEnv('HOME', world.machineHome)
    vi.stubEnv('CODEX_HOME', world.folders.decoy)
    expect(await sitesFor(world, world.accountHome)).toEqual(agreeing('account'))
  })
})
