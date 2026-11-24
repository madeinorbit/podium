/**
 * EVERY READ OF THE MACHINE'S OWN LOGIN FOLLOWS ONE RULE (POD-7496, managed
 * installs §4.2; the launch half is POD-7494's podium-only-login.test.ts).
 *
 * Where the machine's own login of a harness is the Podium home
 * (`ownLoginInPodiumHome`), the reads of the `default` account read there: its
 * model list (Podium's Codex run in the Podium home), Responses calls and quota
 * (the token in the Podium home's auth file), its usage (the rollouts there), and a
 * conversation moved to or from `default` (placed in the Podium home). Where
 * it is the person's folder, those reads stay there.
 *
 * The machine states, for Codex: Podium's install alone; both installs with
 * the person signed in to their own copy; both installs with only Podium's
 * copy signed in (the person installed their own later and never signed in
 * there: the Podium home keeps the login); only the person's install; both
 * signed out; no install.
 *
 * Driven through the daemon's entry points with the process and network
 * boundaries stubbed: recording fake Codex binaries, a fetch that records the
 * bearer token it was sent.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { ResolvedHarnessExecutable, ResolvedHarnessInventory } from '@podium/harness'
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexAuthPathFor, codexHandlers, resolveCodexDaemonAuth } from './control/codex'
import { execHandlers } from './control/exec'
import { inventoryHandlers } from './control/inventory'
import { managementQuotaFetcher, resolveManagementAccount } from './harness-management'
import { conversationHandlers } from './homes/conversation'
import { ownLoginInPodiumHome, snapshotHomeFacts } from './homes/own-login'
import { homeQuotaReader } from './homes/probes'
import { HomeRegistry } from './homes/registry'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

type MachineState = 'only-managed' | 'both' | 'only-person' | 'none'
/** Which side holds a Codex sign-in. */
type SignedIn = 'person' | 'podium' | 'both' | 'neither'

const THREAD = '22222222-2222-4222-8222-222222222222'
const CWD = '/repo/app'
const ROLLOUT = join('sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`)

let root: string
let person: string
let homes: HomeRegistry
let bin: { person: string; managed: string }
let records: string

const podiumCodex = () => homes.podiumHomeAt('codex').dir
const personCodex = () => join(person, '.codex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'own-login-reads-'))
  person = join(root, 'person')
  records = join(root, 'records')
  await mkdir(person, { recursive: true })
  await mkdir(records, { recursive: true })
  homes = new HomeRegistry({ root: join(root, 'state', 'homes') })
  // A recording fake per install: which binary ran, with which CODEX_HOME.
  bin = {
    person: join(root, 'bin', 'person', 'codex'),
    managed: join(root, 'bin', 'managed', 'codex'),
  }
  for (const [label, path] of Object.entries(bin)) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(
      path,
      `#!/bin/sh\necho "CODEX_HOME=\${CODEX_HOME-<unset>}" > '${join(records, label)}'\necho '[]'\n`,
    )
    await chmod(path, 0o755)
  }
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

const line = (record: object) => `${JSON.stringify(record)}\n`

/** A Codex state root: a `label`-marked sign-in when `signedIn`, and one rollout with usage. */
async function codexRoot(dir: string, label: string, signedIn: boolean): Promise<void> {
  await mkdir(join(dir, ROLLOUT, '..'), { recursive: true })
  if (signedIn)
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: `codex-${label}`, refresh_token: 'r', account_id: `acct-${label}` },
      }),
    )
  const at = new Date().toISOString()
  await writeFile(
    join(dir, ROLLOUT),
    line({ type: 'session_meta', payload: { id: THREAD, cwd: CWD, timestamp: at } }) +
      line({ type: 'turn_context', payload: { model: `gpt-${label}` } }) +
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

/** The machine in `state`, signed in on the `signedIn` side(s). */
async function machine(state: MachineState, signedIn: SignedIn): Promise<ResolvedHarnessInventory> {
  const inPerson = signedIn === 'person' || signedIn === 'both'
  const inPodium = signedIn === 'podium' || signedIn === 'both'
  // The person's folder: only where they hold a sign-in or a rollout of their own.
  if (inPerson || state === 'only-managed') await codexRoot(personCodex(), 'person', inPerson)
  if (state !== 'none')
    await codexRoot(homes.ensurePodiumHome('codex').home.dir, 'podium', inPodium)
  const base = testHarnessSnapshot({}, 3, {})
  const executables = new Map(base.executables)
  executables.delete('codex')
  if (state === 'both' || state === 'only-person')
    executables.set('codex', { kind: 'codex', path: bin.person, version: '0.160.0', generation: 3 })
  const managed = new Map<BuiltinHarnessKind, ResolvedHarnessExecutable>()
  if (state === 'only-managed' || state === 'both')
    managed.set('codex', {
      kind: 'codex',
      path: bin.managed,
      version: '0.171.0',
      generation: 3,
      release: 1,
    })
  return {
    ...base,
    executables,
    managed,
    commandEnvironment: {
      ...base.commandEnvironment,
      env: Object.freeze({ PATH: '/usr/bin:/bin', HOME: person }),
      machineHome: person,
    },
  }
}

function daemonCtx(snapshot: ResolvedHarnessInventory) {
  const sent: DaemonMessage[] = []
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    machineId: 'm-own-login',
    homeDir: person,
    usageMemo: {},
    homes,
    harnessRuntime: {
      current: async () => snapshot,
      settled: () => snapshot,
      isCurrent: (s: unknown) => s === snapshot,
    },
  }
  return { ctx: ctx as never, sent }
}

async function waitFor<T extends DaemonMessage['type']>(
  sent: DaemonMessage[],
  type: T,
): Promise<Extract<DaemonMessage, { type: T }>> {
  await vi.waitFor(() => expect(sent.some((m) => m.type === type)).toBe(true), { timeout: 15_000 })
  return sent.find((m) => m.type === type) as Extract<DaemonMessage, { type: T }>
}

/** Where a path lives: `podium`, `person` or `elsewhere`. */
function sideOf(path: string | undefined): string {
  if (path?.startsWith(podiumCodex() + sep)) return 'podium'
  if (path?.startsWith(personCodex() + sep)) return 'person'
  return 'elsewhere'
}

/** Which recording fake ran, and the CODEX_HOME it saw, as `<binary> in <side>`. */
async function probeRan(): Promise<string> {
  const ran: string[] = []
  for (const label of ['person', 'managed'] as const) {
    const text = await readFile(join(records, label), 'utf8').catch(() => undefined)
    if (!text) continue
    const home = /CODEX_HOME=(.*)/.exec(text)?.[1]?.trim() ?? ''
    // A listing in the person's folders runs in a contained copy of them
    // (POD-7390); only the Podium home is named as itself.
    const side = home === podiumCodex() ? 'podium' : 'person'
    ran.push(`${label} in ${side}`)
  }
  return ran.join(', ') || 'nothing'
}

/** The four `default` reads on one machine, each answered by the side it read. */
async function defaultReads(state: MachineState, signedIn: SignedIn) {
  const snapshot = await machine(state, signedIn)

  // The model list: which Codex ran, in which folder.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
  const probe = daemonCtx(snapshot)
  inventoryHandlers.modelProbeRequest(probe.ctx, { type: 'modelProbeRequest', requestId: 'mp' })
  await waitFor(probe.sent, 'modelProbeResult')
  vi.unstubAllGlobals()

  // The quota: whose token the usage endpoint was sent.
  const tokens: string[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes('chatgpt.com')) {
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? ''
      tokens.push(/^Bearer codex-(.+)$/.exec(auth)?.[1] ?? 'none')
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  await managementQuotaFetcher(daemonCtx(snapshot).ctx).getAgentQuota(true)
  vi.unstubAllGlobals()

  // The usage: which folder the harvested Codex rollouts came from.
  const usage = daemonCtx(snapshot)
  execHandlers.usageRequest(usage.ctx, {
    type: 'usageRequest',
    requestId: 'u',
    sinceMs: 0,
    withSources: true,
  })
  const result = await waitFor(usage.sent, 'usageResult')
  const usageSides = [
    ...new Set(
      (result.sources ?? []).filter((s) => s.harness === 'codex').map((s) => sideOf(s.path)),
    ),
  ]

  return {
    models: await probeRan(),
    quota: [...new Set(tokens)].join('+') || 'none',
    usage: usageSides.sort().join('+') || 'none',
  }
}

describe('the rule: where the machine’s own login of Codex lives', () => {
  const cases: [MachineState, SignedIn, string | undefined][] = [
    ['only-managed', 'neither', 'codex'],
    ['only-managed', 'person', 'codex'],
    ['both', 'person', undefined],
    ['both', 'both', undefined],
    // The person installed their own copy later and never signed in to it.
    ['both', 'podium', 'codex'],
    ['both', 'neither', undefined],
    ['none', 'person', undefined],
  ]
  it.each(cases)('%s, signed in on %s: %s', async (state, signedIn, expected) => {
    const snapshot = await machine(state, signedIn)
    const facts = snapshotHomeFacts(snapshot, { homes, account: { home: person, env: {} } })
    expect(ownLoginInPodiumHome('codex', facts)).toBe(expected)
    // Without the login facts, both installs keep the person's side.
    if (state === 'both')
      expect(ownLoginInPodiumHome('codex', snapshotHomeFacts(snapshot))).toBe(undefined)
  })
})

describe('the model list, quota and usage of the default account (gaps 1 and 2)', () => {
  it('only Podium’s install: read in the Podium home, never the person’s leftover folder', async () => {
    // The person's folder still holds an old sign-in; their copy is gone.
    expect(await defaultReads('only-managed', 'both')).toEqual({
      models: 'managed in podium',
      quota: 'podium',
      usage: 'podium',
    })
  })

  it('both installs, the person signed in to their own copy: read in their folder', async () => {
    expect(await defaultReads('both', 'both')).toEqual({
      models: 'person in person',
      quota: 'person',
      usage: 'person',
    })
  })

  it('both installs, only Podium’s copy signed in: the Podium home keeps the login', async () => {
    expect(await defaultReads('both', 'podium')).toEqual({
      models: 'managed in podium',
      quota: 'podium',
      usage: 'podium',
    })
  })
})

describe('Codex Responses auth and quota use the same default login', () => {
  const cases: [MachineState, SignedIn, 'person' | 'podium'][] = [
    ['only-managed', 'podium', 'podium'],
    ['only-managed', 'both', 'podium'],
    ['both', 'both', 'person'],
    ['only-person', 'both', 'person'],
    ['both', 'podium', 'podium'],
  ]

  it.each(cases)('%s, signed in on %s: Responses reads %s auth', async (state, signedIn, side) => {
    const { ctx, sent } = daemonCtx(await machine(state, signedIn))
    const account = await resolveManagementAccount(ctx)
    expect(account).toBeDefined()
    const codexHome = account?.ownLoginHomes?.codex
    const expectedPath = join(side === 'podium' ? podiumCodex() : personCodex(), 'auth.json')
    expect(codexAuthPathFor(account?.home, codexHome)).toBe(expectedPath)
    expect(await resolveCodexDaemonAuth(account?.home, { codexHome })).toEqual({
      accessToken: `codex-${side}`,
      accountId: `acct-${side}`,
    })
    const before = await readFile(expectedPath, 'utf8')
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer codex-${side}`)
      expect(headers.get('chatgpt-account-id')).toBe(`acct-${side}`)
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed' },
        })}\n\n`,
      )
    })
    vi.stubGlobal('fetch', fetchImpl)

    codexHandlers.codexCompleteRequest(ctx, {
      type: 'codexCompleteRequest',
      requestId: 'complete',
      model: 'gpt-fixture',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      effort: 'medium',
    })

    expect(await waitFor(sent, 'codexCompleteResult')).toEqual({
      type: 'codexCompleteResult',
      requestId: 'complete',
      ok: true,
      text: '',
      toolCalls: [],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await readFile(expectedPath, 'utf8')).toBe(before)
  })

  it('only Podium’s install without its login never falls back to the person’s old login', async () => {
    const { ctx, sent } = daemonCtx(await machine('only-managed', 'person'))
    const fetchImpl = vi.fn(() => {
      throw new Error('a missing Podium login must not make a request')
    })
    vi.stubGlobal('fetch', fetchImpl)

    codexHandlers.codexCompleteRequest(ctx, {
      type: 'codexCompleteRequest',
      requestId: 'missing',
      model: 'gpt-fixture',
      messages: [],
      tools: [],
      effort: 'medium',
    })

    expect(await waitFor(sent, 'codexCompleteResult')).toMatchObject({
      ok: false,
      error: expect.stringContaining(join(podiumCodex(), 'auth.json')),
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(cases)('%s, signed in on %s: quota counts %s once', async (state, signedIn, side) => {
    const { ctx } = daemonCtx(await machine(state, signedIn))
    const other = (await homes.ensure('cred_other', 'codex')).home
    await codexRoot(other.dir, 'other', true)
    const tokens: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{}')
    })
    const readHomes = homeQuotaReader({
      homes: () => homes.list(),
      account: async () => {
        const account = await resolveManagementAccount(ctx)
        return account && { ...account, env: account.machineEnv }
      },
    })

    const defaultQuota = await managementQuotaFetcher(ctx).getAgentQuota(true)
    const homeQuota = await readHomes(true)
    const codexQuota = [...defaultQuota, ...homeQuota].filter((wire) => wire.agent === 'codex')
    const expectedHomes = ['default', other.homeId]
    const expectedTokens = [`Bearer codex-${side}`, 'Bearer codex-other']
    if (side === 'person') {
      expectedHomes.push('podium:codex')
      expectedTokens.push('Bearer codex-podium')
    }
    expect(codexQuota.map((wire) => wire.homeId ?? 'default').sort()).toEqual(expectedHomes.sort())
    expect(codexQuota.every((wire) => wire.status === 'ok')).toBe(true)
    expect(tokens.sort()).toEqual(expectedTokens.sort())
  })
})

describe('a conversation moved to or from the default account (gap 3)', () => {
  async function prepare(
    snapshot: ResolvedHarnessInventory,
    to: { toHomeId: string; account: string; fromAccount: string },
  ) {
    const { ctx, sent } = daemonCtx(snapshot)
    conversationHandlers.conversationPrepareRequest(ctx, {
      type: 'conversationPrepareRequest',
      requestId: 'c',
      sessionId: 's-conv',
      agentKind: 'codex',
      cwd: CWD,
      resume: { kind: 'codex-thread', value: THREAD },
      ...to,
    } as never)
    return await waitFor(sent, 'conversationPrepareResult')
  }
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    )

  it('only Podium’s install: a move to `default` lands in the Podium home', async () => {
    const snapshot = await machine('only-managed', 'podium')
    // The conversation ran on a sign-in folder of a credential.
    const signIn = (await homes.ensure('cred_a', 'codex')).home.dir
    await rm(join(podiumCodex(), ROLLOUT))
    await rm(join(personCodex(), ROLLOUT))
    await mkdir(join(signIn, ROLLOUT, '..'), { recursive: true })
    await writeFile(
      join(signIn, ROLLOUT),
      line({ type: 'session_meta', payload: { id: THREAD, model_provider: 'openai' } }),
    )
    const result = await prepare(snapshot, {
      toHomeId: 'default',
      account: 'none',
      fromAccount: 'cred_a',
    })
    expect(result).toMatchObject({ ok: true, placed: 'copied' })
    expect(await exists(join(personCodex(), ROLLOUT))).toBe(false)
    // The sign-in there is a login file: the provider stays the one it signs in to.
    const moved = await readFile(join(podiumCodex(), ROLLOUT), 'utf8')
    expect(JSON.parse(moved.split('\n')[0] as string).payload.model_provider).toBe('openai')
  })

  it('only Podium’s install: a move away from `default` finds it in the Podium home', async () => {
    const snapshot = await machine('only-managed', 'podium')
    await rm(join(personCodex(), ROLLOUT))
    const signIn = (await homes.ensure('cred_a', 'codex')).home.dir
    const result = await prepare(snapshot, {
      toHomeId: 'cred_a:codex',
      account: 'cred_a',
      fromAccount: 'none',
    })
    expect(result).toMatchObject({ ok: true, placed: 'copied' })
    expect(await readFile(join(signIn, ROLLOUT), 'utf8')).toContain('gpt-podium')
  })

  it('both installs, the person signed in to their own copy: `default` stays their folder', async () => {
    const snapshot = await machine('both', 'person')
    await rm(join(podiumCodex(), ROLLOUT))
    const result = await prepare(snapshot, {
      toHomeId: 'default',
      account: 'none',
      fromAccount: 'none',
    })
    expect(result).toMatchObject({ ok: true, placed: 'in-place' })
  })
})
