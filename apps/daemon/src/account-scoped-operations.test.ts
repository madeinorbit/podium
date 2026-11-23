/**
 * ACCOUNT-SCOPED HARNESS OPERATIONS READ THE ACCOUNT (POD-6534, F06-F09).
 *
 * Operations with no session — the model probe (CLI children and Claude's
 * OAuth token), the Codex Responses call, quota, the usage scan, credential
 * export and transcript reads — must answer for the ACCOUNT the session child
 * runs as. Each is driven through the daemon entry point production calls,
 * and the test reads back WHICH folder it touched: a distinct token, rollout,
 * transcript and credential sits in every candidate folder.
 *
 * Setup: machine home M (the daemon's HOME), account home A (the credential
 * home), and sentinel folders S. CODEX_HOME, GROK_HOME and PI_CODING_AGENT_DIR
 * point at sentinels in the snapshot's command env; those plus
 * CLAUDE_CONFIG_DIR and XDG_* point at sentinels in the daemon's process.env.
 * Every row must read A — never M, never a sentinel.
 *
 * A command-env CLAUDE_CONFIG_DIR / XDG_* is the operator's choice for THEIR
 * account (POD-6604): a named account (A ≠ M) never follows it — the context,
 * the child and every reader land in A — while the machine's own account
 * (A = M) keeps following it, identically in the context and every reader.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { ResolvedHarnessInventory } from '@podium/harness'
import { CODEX_RESPONSES_URL, claudeProjectSlug, piCwdSlug } from '@podium/harness'
import { asSessionId } from '@podium/model'
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Bun snapshots os.homedir() at startup; a homedir() fallback must see M.
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>()
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() }
})

// Transcript reads: record the chain each grammar resolved for the read.
const chains = vi.hoisted(() => ({ byResume: new Map<string, string[]>() }))
vi.mock('@podium/harness/store', async (original) => {
  const actual = await original<typeof import('@podium/harness/store')>()
  return {
    ...actual,
    transcriptSourceFromGrammar: async (
      grammar: Parameters<typeof actual.transcriptSourceFromGrammar>[0],
      input: Parameters<typeof actual.transcriptSourceFromGrammar>[1],
    ) => {
      const { declaredValue } = await import('@podium/harness')
      const chainPaths = declaredValue(grammar.chainPaths)
      if (chainPaths && input.resumeValue) {
        chains.byResume.set(input.resumeValue, await chainPaths(input))
      }
      return actual.transcriptSourceFromGrammar(grammar, input)
    },
  }
})

import { codexHandlers } from './control/codex'
import { execHandlers } from './control/exec'
import { inventoryHandlers } from './control/inventory'
import { CONTROL_HANDLERS } from './control/registry'
import { readTranscript } from './control/transcripts'
import {
  managementAccountFor,
  managementContextFor,
  managementQuotaFetcher,
  resolveManagementAccount,
} from './harness-management'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

const PROBED = ['codex', 'grok', 'pi', 'opencode', 'cursor'] as const
const SELECTORS = [
  'HOME',
  'CODEX_HOME',
  'GROK_HOME',
  'PI_CODING_AGENT_DIR',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
] as const
const CWD = '/repo/app'
const SESSION = {
  claude: '11111111-1111-4111-8111-111111111111',
  codex: '22222222-2222-4222-8222-222222222222',
  grok: '33333333-3333-4333-8333-333333333333',
  pi: '44444444-4444-4444-8444-444444444444',
}

type Label = string

interface World {
  root: string
  machineHome: string
  accountHome: string
  /** Every candidate folder, by label. A row's answer is the label it hit. */
  folders: Map<string, Label>
  sentinel: Record<'codex' | 'claude' | 'grok' | 'pi' | 'xdgData' | 'xdgConfig', string>
  bin: string
  records: string
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  chains.byResume.clear()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function idToken(email: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ email })}.sig`
}

const line = (record: object) => `${JSON.stringify(record)}\n`

/** A Codex state root holding a `label`-marked auth file and rollout. */
async function codexRoot(dir: string, label: Label): Promise<void> {
  const day = join(dir, 'sessions', '2026', '01', '01')
  await mkdir(day, { recursive: true })
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: `codex-${label}`,
        refresh_token: 'refresh',
        id_token: idToken(`${label}@example.test`),
        account_id: `acct-${label}`,
      },
    }),
  )
  const at = new Date().toISOString()
  await writeFile(
    join(day, `rollout-2026-01-01T00-00-00-${SESSION.codex}.jsonl`),
    line({ type: 'session_meta', payload: { id: SESSION.codex, cwd: CWD, timestamp: at } }) +
      line({ type: 'turn_context', payload: { model: 'gpt-fixture' } }) +
      line({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
        },
      }),
  )
}

/** A Claude config root: OAuth credential, one transcript carrying usage. */
async function claudeRoot(dir: string, label: Label): Promise<void> {
  const project = join(dir, 'projects', claudeProjectSlug(CWD))
  await mkdir(project, { recursive: true })
  await writeFile(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `claude-${label}`,
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  )
  await writeFile(
    join(project, `${SESSION.claude}.jsonl`),
    line({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      requestId: `req-${label}`,
      message: { model: 'claude-fixture', usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  )
}

/** A Grok root: auth, one session snapshot (usage) with its updates file. */
async function grokRoot(dir: string, label: Label): Promise<void> {
  const session = join(dir, 'sessions', encodeURIComponent(CWD), SESSION.grok)
  await mkdir(session, { recursive: true })
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ entry: { key: `grok-${label}` } }))
  await writeFile(
    join(session, 'signals.json'),
    JSON.stringify({
      contextTokensUsed: 10,
      assistantMessageCount: 1,
      primaryModelId: 'grok-fixture',
    }),
  )
  await writeFile(
    join(session, 'summary.json'),
    JSON.stringify({ last_active_at: new Date().toISOString() }),
  )
  await writeFile(join(session, 'updates.jsonl'), line({ label }))
}

/** A Pi agent dir with one session file. */
async function piRoot(dir: string): Promise<void> {
  const bucket = join(dir, 'sessions', piCwdSlug(CWD))
  await mkdir(bucket, { recursive: true })
  await writeFile(
    join(bucket, `2026-01-01T00-00-00-000Z_${SESSION.pi}.jsonl`),
    line({ type: 'session' }),
  )
}

async function world(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'account-scoped-ops-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const machineHome = join(root, 'machine')
  const accountHome = join(root, 'account')
  const s = (name: string) => join(root, 'sentinel', name)
  const sentinel = {
    codex: s('codex'),
    claude: s('claude'),
    grok: s('grok'),
    pi: s('pi'),
    xdgData: s('xdg-data'),
    xdgConfig: s('xdg-config'),
  }
  const folders = new Map<string, Label>([
    [machineHome, 'machine'],
    [accountHome, 'account'],
    ...Object.entries(sentinel).map(([name, dir]) => [dir, `sentinel:${name}`] as [string, Label]),
  ])
  for (const [home, label] of [
    [machineHome, 'machine'],
    [accountHome, 'account'],
  ] as const) {
    await codexRoot(join(home, '.codex'), label)
    await claudeRoot(join(home, '.claude'), label)
    await grokRoot(join(home, '.grok'), label)
    await piRoot(join(home, '.pi', 'agent'))
  }
  await codexRoot(sentinel.codex, 'sentinel')
  await claudeRoot(sentinel.claude, 'sentinel')
  await grokRoot(sentinel.grok, 'sentinel')
  await piRoot(sentinel.pi)
  await mkdir(sentinel.xdgData, { recursive: true })
  await mkdir(sentinel.xdgConfig, { recursive: true })

  // A recording fake for every CLI-probed harness: it writes the selectors
  // it was started with, then lists no models.
  const bin = join(root, 'bin')
  const records = join(root, 'records')
  await mkdir(bin, { recursive: true })
  await mkdir(records, { recursive: true })
  for (const kind of PROBED) {
    const script = join(bin, kind)
    const lines = SELECTORS.map((name) => `echo "${name}=\${${name}-<unset>}"`).join('\n')
    await writeFile(script, `#!/bin/sh\n{\n${lines}\n} > '${join(records, kind)}'\necho '[]'\n`)
    await chmod(script, 0o755)
  }
  return { root, machineHome, accountHome, folders, sentinel, bin, records }
}

/** The folder label a path lives in; the deepest match wins. */
function folderOf(w: World, path: string | undefined): Label {
  if (!path) return 'none'
  let best: { dir: string; label: Label } | undefined
  for (const [dir, label] of w.folders) {
    if ((path === dir || path.startsWith(dir + sep)) && (!best || dir.length > best.dir.length)) {
      best = { dir, label }
    }
  }
  return best?.label ?? 'none'
}

/** Ambient decoys in the daemon's own environment. */
function stubDaemonEnv(w: World): void {
  vi.stubEnv('HOME', w.machineHome)
  vi.stubEnv('CODEX_HOME', w.sentinel.codex)
  vi.stubEnv('CLAUDE_CONFIG_DIR', w.sentinel.claude)
  vi.stubEnv('GROK_HOME', w.sentinel.grok)
  vi.stubEnv('PI_CODING_AGENT_DIR', w.sentinel.pi)
  vi.stubEnv('XDG_DATA_HOME', w.sentinel.xdgData)
  vi.stubEnv('XDG_CONFIG_HOME', w.sentinel.xdgConfig)
  vi.stubEnv('ANTHROPIC_API_KEY', undefined)
}

/** The inventory snapshot: the fake CLIs, and a command env with `extra`. */
function snapshotFor(w: World, extra: Record<string, string>): ResolvedHarnessInventory {
  const paths: Partial<Record<BuiltinHarnessKind, string>> = {}
  for (const kind of PROBED) paths[kind] = join(w.bin, kind)
  const base = testHarnessSnapshot(paths)
  return {
    ...base,
    commandEnvironment: {
      ...base.commandEnvironment,
      env: Object.freeze({ PATH: '/usr/bin:/bin', HOME: w.machineHome, ...extra }),
      machineHome: w.machineHome,
    },
  }
}

/** The ambient selectors the brief's matrix puts in the command env. */
function decoyCommandEnv(w: World): Record<string, string> {
  return {
    CODEX_HOME: w.sentinel.codex,
    GROK_HOME: w.sentinel.grok,
    PI_CODING_AGENT_DIR: w.sentinel.pi,
  }
}

function daemonCtx(
  w: World,
  snapshot: ResolvedHarnessInventory | undefined,
  home: string = w.accountHome,
) {
  const sent: DaemonMessage[] = []
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    machineId: 'm-account',
    homeDir: home,
    accountHome: { path: home, source: 'configured' as const },
    usageMemo: {},
    ...(snapshot
      ? {
          harnessRuntime: {
            current: async () => snapshot,
            settled: () => snapshot,
            isCurrent: (s: unknown) => s === snapshot,
          },
        }
      : {}),
  }
  return { ctx, sent }
}

type Ctx = ReturnType<typeof daemonCtx>['ctx']
const asAny = <T>(ctx: Ctx) => ctx as unknown as T

/** Global fetch stub: records the auth header per URL, answers `{}`/no models. */
function stubFetch(): Map<string, Record<string, string>> {
  const seen = new Map<string, Record<string, string>>()
  vi.stubGlobal('fetch', async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    seen.set(String(url), { ...(init?.headers ?? {}) })
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  })
  return seen
}

function bearerLabel(headers: Record<string, string> | undefined): Label {
  const value = headers?.Authorization ?? headers?.authorization
  const match = /^Bearer (?:codex|claude|grok)-(.+)$/.exec(value ?? '')
  return match?.[1] ?? 'none'
}

async function recordOf(w: World, kind: string): Promise<Record<string, string>> {
  const text = await readFile(join(w.records, kind), 'utf8')
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  )
}

async function waitFor<T extends DaemonMessage['type']>(
  sent: DaemonMessage[],
  type: T,
): Promise<Extract<DaemonMessage, { type: T }>> {
  await vi.waitFor(() => expect(sent.some((m) => m.type === type)).toBe(true), { timeout: 15_000 })
  return sent.find((m) => m.type === type) as Extract<DaemonMessage, { type: T }>
}

/** Run one group of rows; a throw becomes a row of its own, so every other
 *  row still reports (the base-failure evidence reads row by row). */
async function block(
  rows: Record<string, Label>,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run()
  } catch (err) {
    rows[`${name} (threw)`] = err instanceof Error ? err.message : String(err)
  } finally {
    vi.unstubAllGlobals()
  }
}

/** Every row of the matrix, each answered by the folder it touched. */
async function matrix(w: World, snapshot: ResolvedHarnessInventory, home: string = w.accountHome) {
  const rows: Record<string, Label> = {}

  // Model probe: each CLI child's HOME and own selector; Claude's OAuth token.
  await block(rows, 'probe', async () => {
    const seen = stubFetch()
    const { ctx, sent } = daemonCtx(w, snapshot, home)
    inventoryHandlers.modelProbeRequest(asAny(ctx), { type: 'modelProbeRequest', requestId: 'mp' })
    await waitFor(sent, 'modelProbeResult')
    const own: Record<(typeof PROBED)[number], string | undefined> = {
      codex: 'CODEX_HOME',
      grok: 'GROK_HOME',
      pi: 'PI_CODING_AGENT_DIR',
      opencode: undefined,
      cursor: undefined,
    }
    for (const kind of PROBED) {
      const record = await recordOf(w, kind).catch(() => ({}) as Record<string, string>)
      rows[`probe ${kind} HOME`] = folderOf(w, record.HOME)
      const selector = own[kind]
      if (selector) rows[`probe ${kind} ${selector}`] = folderOf(w, record[selector])
    }
    const models = [...seen].find(([url]) => url.includes('api.anthropic.com/v1/models'))
    rows['probe claude OAuth token'] = bearerLabel(models?.[1])
    vi.unstubAllGlobals()
  })

  // Codex Responses call (stubbed fetch): whose token goes out.
  await block(rows, 'codex responses', async () => {
    const seen = stubFetch()
    const { ctx, sent } = daemonCtx(w, snapshot, home)
    codexHandlers.codexCompleteRequest(asAny(ctx), {
      type: 'codexCompleteRequest',
      requestId: 'cx',
      model: 'gpt-fixture',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      effort: 'low',
    })
    await waitFor(sent, 'codexCompleteResult')
    rows['codex responses token'] = bearerLabel(seen.get(CODEX_RESPONSES_URL))
    vi.unstubAllGlobals()
  })

  // Quota (stubbed fetch), through the fetcher the daemon composes.
  await block(rows, 'quota', async () => {
    const seen = stubFetch()
    const { ctx } = daemonCtx(w, snapshot, home)
    await managementQuotaFetcher(asAny(ctx)).getAgentQuota(true)
    const by = (host: string) => [...seen].find(([url]) => url.includes(host))?.[1]
    rows['quota claude'] = bearerLabel(by('api.anthropic.com/api/oauth/usage'))
    rows['quota codex'] = bearerLabel(by('chatgpt.com/backend-api/wham/usage'))
    rows['quota grok'] = bearerLabel(by('grok.com'))
    vi.unstubAllGlobals()
  })

  // Usage scan: which folders the harvested files came from, per harness.
  await block(rows, 'usage', async () => {
    const { ctx, sent } = daemonCtx(w, snapshot, home)
    execHandlers.usageRequest(asAny(ctx), {
      type: 'usageRequest',
      requestId: 'u',
      sinceMs: 0,
      withSources: true,
    })
    const result = await waitFor(sent, 'usageResult')
    for (const harness of ['claude-code', 'codex', 'grok']) {
      const labels = [
        ...new Set(
          (result.sources ?? [])
            .filter((source) => source.harness === harness)
            .map((source) => folderOf(w, source.path)),
        ),
      ]
      rows[`usage ${harness}`] = labels.join('+') || 'none'
    }
  })

  // Credential export (an account operation, not guarded propagation).
  await block(rows, 'credential export', async () => {
    const { ctx, sent } = daemonCtx(w, snapshot, home)
    CONTROL_HANDLERS.credentialExportRequest(asAny(ctx), {
      type: 'credentialExportRequest',
      requestId: 'ce',
      kinds: ['codex', 'claude-code', 'grok'],
    })
    const result = await waitFor(sent, 'credentialExportResult')
    for (const kind of ['codex', 'claude-code', 'grok'] as const) {
      const bundle = result.bundles.find((b) => b.kind === kind)
      const text = bundle ? Buffer.from(bundle.contentBase64, 'base64').toString() : ''
      const match = /(?:codex|claude|grok)-(account|machine|sentinel|selected)/.exec(text)
      rows[`credential export ${kind}`] = match?.[1] ?? 'none'
    }
  })

  // Transcript read roots: the chain each grammar resolved.
  await block(rows, 'transcript', async () => {
    const reads: [string, BuiltinHarnessKind, string, string][] = [
      ['claude-code', 'claude-code', 'claude-session', SESSION.claude],
      ['codex', 'codex', 'codex-thread', SESSION.codex],
      ['grok', 'grok', 'grok-session', SESSION.grok],
      ['pi', 'pi', 'pi-session', SESSION.pi],
    ]
    for (const [name, agentKind, resumeKind, value] of reads) {
      const { ctx } = daemonCtx(w, snapshot, home)
      await readTranscript(asAny(ctx), {
        type: 'transcriptRead',
        requestId: `t-${name}`,
        sessionId: asSessionId(`t-${name}`),
        agentKind,
        cwd: CWD,
        resume: { kind: resumeKind, value },
        direction: 'before',
        limit: 10,
      })
      const chain = chains.byResume.get(value) ?? []
      rows[`transcript ${name}`] =
        [...new Set(chain.map((p) => folderOf(w, p)))].join('+') || 'none'
    }
  })
  return rows
}

describe('account-scoped operations read the account home, never a sentinel', () => {
  it('every row reads A with decoy selectors in the command env and the daemon env', async () => {
    const w = await world()
    stubDaemonEnv(w)
    const rows = await matrix(w, snapshotFor(w, decoyCommandEnv(w)))
    expect(rows).toEqual(Object.fromEntries(Object.keys(rows).map((row) => [row, 'account'])))
    // The matrix is complete: one row per operation and harness.
    expect(Object.keys(rows)).toEqual([
      'probe codex HOME',
      'probe codex CODEX_HOME',
      'probe grok HOME',
      'probe grok GROK_HOME',
      'probe pi HOME',
      'probe pi PI_CODING_AGENT_DIR',
      'probe opencode HOME',
      'probe cursor HOME',
      'probe claude OAuth token',
      'codex responses token',
      'quota claude',
      'quota codex',
      'quota grok',
      'usage claude-code',
      'usage codex',
      'usage grok',
      'credential export codex',
      'credential export claude-code',
      'credential export grok',
      'transcript claude-code',
      'transcript codex',
      'transcript grok',
      'transcript pi',
    ])
  }, 60_000)

  it('a command-env CLAUDE_CONFIG_DIR / XDG_* never moves a named account: context, child and every reader read A', async () => {
    const w = await world()
    stubDaemonEnv(w)
    // The operator's own selectors, in the machine command env this time.
    const snapshot = snapshotFor(w, {
      ...decoyCommandEnv(w),
      CLAUDE_CONFIG_DIR: w.sentinel.claude,
      XDG_DATA_HOME: w.sentinel.xdgData,
      XDG_CONFIG_HOME: w.sentinel.xdgConfig,
    })

    const { ctx } = daemonCtx(w, snapshot)
    const account = await resolveManagementAccount(asAny(ctx))
    if (!account) throw new Error('no management account')
    const claude = managementAccountFor(account, 'claude-code')
    const opencode = managementContextFor(account, 'opencode')
    const rows = await matrix(w, snapshot)
    expect(Object.keys(rows)).toHaveLength(23)
    // The OpenCode probe CHILD: its HOME, and the operator's XDG folders.
    const record = await recordOf(w, 'opencode')
    const unsetOr = (value: string | undefined) =>
      value === '<unset>' ? 'account' : folderOf(w, value)
    const observed: Record<string, Label> = {
      'context claude-code roots.state': folderOf(w, claude.roots.state),
      'context claude-code env CLAUDE_CONFIG_DIR': unsetOr(
        claude.env.CLAUDE_CONFIG_DIR ?? '<unset>',
      ),
      'context opencode roots.state': folderOf(w, opencode?.roots.state),
      'context opencode roots.config': folderOf(w, opencode?.roots.config),
      ...rows,
      'probe opencode child XDG_DATA_HOME': unsetOr(record.XDG_DATA_HOME),
      'probe opencode child XDG_CONFIG_HOME': unsetOr(record.XDG_CONFIG_HOME),
    }
    // Every observation reads A ("account" for an unset selector: the child
    // then derives the folder from its HOME, which is A).
    expect(observed).toEqual(
      Object.fromEntries(Object.keys(observed).map((row) => [row, 'account'])),
    )
  }, 60_000)

  it("the machine's own account keeps following a command-env CLAUDE_CONFIG_DIR / XDG_DATA_HOME, in the context and every reader (guard)", async () => {
    const w = await world()
    stubDaemonEnv(w)
    const claudeSelected = join(w.root, 'selected-claude')
    const xdgSelected = join(w.root, 'selected-xdg-data')
    w.folders.set(claudeSelected, 'selected')
    w.folders.set(xdgSelected, 'selected')
    await claudeRoot(claudeSelected, 'selected')
    await mkdir(xdgSelected, { recursive: true })
    const snapshot = snapshotFor(w, {
      ...decoyCommandEnv(w),
      CLAUDE_CONFIG_DIR: claudeSelected,
      XDG_DATA_HOME: xdgSelected,
    })

    const { ctx } = daemonCtx(w, snapshot, w.machineHome)
    const account = await resolveManagementAccount(asAny(ctx))
    if (!account) throw new Error('no management account')
    expect(folderOf(w, managementAccountFor(account, 'claude-code').roots.state)).toBe('selected')
    expect(folderOf(w, managementContextFor(account, 'opencode')?.roots.state)).toBe('selected')

    const rows = await matrix(w, snapshot, w.machineHome)
    const claudeRows = [
      'probe claude OAuth token',
      'quota claude',
      'usage claude-code',
      'credential export claude-code',
      'transcript claude-code',
    ]
    expect(Object.fromEntries(claudeRows.map((row) => [row, rows[row]]))).toEqual(
      Object.fromEntries(claudeRows.map((row) => [row, 'selected'])),
    )
    expect(folderOf(w, (await recordOf(w, 'opencode')).XDG_DATA_HOME)).toBe('selected')
    // Everything else reads the machine home (its own selectors overridden).
    const others = Object.entries(rows).filter(([row]) => !claudeRows.includes(row))
    expect(Object.fromEntries(others)).toEqual(
      Object.fromEntries(others.map(([row]) => [row, 'machine'])),
    )
  }, 60_000)
})

describe('model probe ANTHROPIC_API_KEY (pinned, POD-6534 decision: unchanged)', () => {
  it("lists Claude models with the DAEMON's own ANTHROPIC_API_KEY, over the account OAuth login", async () => {
    const w = await world()
    stubDaemonEnv(w)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-daemon-process')
    const snapshot = snapshotFor(w, {
      ...decoyCommandEnv(w),
      ANTHROPIC_API_KEY: 'sk-command-env',
    })
    const seen = stubFetch()
    const { ctx, sent } = daemonCtx(w, snapshot)
    inventoryHandlers.modelProbeRequest(asAny(ctx), { type: 'modelProbeRequest', requestId: 'key' })
    await waitFor(sent, 'modelProbeResult')
    const headers = [...seen].find(([url]) => url.includes('api.anthropic.com/v1/models'))?.[1]
    // The process env's key, sent as x-api-key; the OAuth token is not sent.
    expect(headers?.['x-api-key']).toBe('sk-daemon-process')
    expect(headers?.authorization).toBeUndefined()
  }, 30_000)
})

describe('credential operations without an inventory snapshot', () => {
  it('refuse instead of reading the daemon env (export and install)', async () => {
    const w = await world()
    stubDaemonEnv(w)
    const { ctx, sent } = daemonCtx(w, undefined)
    CONTROL_HANDLERS.credentialExportRequest(asAny(ctx), {
      type: 'credentialExportRequest',
      requestId: 'ce-none',
      kinds: ['codex', 'grok'],
    })
    expect(await waitFor(sent, 'credentialExportResult')).toEqual({
      type: 'credentialExportResult',
      requestId: 'ce-none',
      bundles: [],
      unavailable: ['codex', 'grok'],
    })

    const before = await readFile(join(w.sentinel.codex, 'auth.json'), 'utf8')
    const donor = Buffer.from(
      JSON.stringify({ tokens: { access_token: 'codex-donor', account_id: 'acct-donor' } }),
    ).toString('base64')
    CONTROL_HANDLERS.credentialInstallRequest(asAny(ctx), {
      type: 'credentialInstallRequest',
      requestId: 'ci-none',
      bundles: [{ kind: 'codex', contentBase64: donor }],
    })
    expect(await waitFor(sent, 'credentialInstallResult')).toEqual({
      type: 'credentialInstallResult',
      requestId: 'ci-none',
      installed: [],
      failed: ['codex'],
    })
    expect(await readFile(join(w.sentinel.codex, 'auth.json'), 'utf8')).toBe(before)
    expect(await readFile(join(w.accountHome, '.codex', 'auth.json'), 'utf8')).not.toContain(
      'codex-donor',
    )
  }, 30_000)
})
