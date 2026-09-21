import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Inventory } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const probeModels = vi.fn<(opts: unknown) => Promise<Record<string, unknown[]>>>()

vi.mock('@podium/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/harness')>()
  return { ...actual, probeAllModels: (opts: unknown) => probeModels(opts) }
})

import {
  managementInventoryCacheKey,
  managementLoginCommandFor,
  resolveManagementCredentialHome,
} from './harness-management.js'

// The login-PTY launch test below exercises the real launch fork with the process
// boundary mocked: no shell, login CLI, daemon or service starts.
const spawned: { cmd: string; args: string[] }[] = []
vi.mock('@podium/process/screen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/process/screen')>()
  return {
    ...actual,
    spawnAgent: (opts: { cmd: string; args: string[] }) => {
      spawned.push({ cmd: opts.cmd, args: opts.args })
      return {
        pid: 4242,
        onFrame: () => () => {},
        onTitle: () => () => {},
        onExit: () => () => {},
        write: () => {},
        resize: () => {},
        redraw: () => {},
        geometry: () => ({ cols: 80, rows: 24 }),
        dispose: () => {},
      }
    },
  }
})
vi.mock('./runtime/server-reap', () => ({ beginServerDriverReap: vi.fn(async () => {}) }))
vi.mock('./runtime/instance-process-reaper', () => ({
  reapInstanceSessionProcesses: vi.fn(async () => ({ examined: 0, remaining: 0 })),
}))
vi.mock('./session-uploads', () => ({ removeSessionUploads: vi.fn() }))
import { execHandlers } from './control/exec.js'
import {
  inventoryHandlers,
  reportInventory,
  runtimeDriverInventory,
} from './control/inventory.js'
import { scanHostUsageSources, scanQuotaHistory } from '@podium/harness/inventory'

describe('harness management ownership boundary (POD-4305 F11/F12)', () => {
  describe('resolveManagementCredentialHome prefers the provisioned account home', () => {
    it.each([
      {
        name: 'account home wins over instance home',
        ctx: { accountHome: { path: '/accounts/alice', source: 'named-instance' as const }, homeDir: '/instance/home' },
        expected: '/accounts/alice',
      },
      {
        name: 'falls back to instance home without an account home',
        ctx: { accountHome: undefined, homeDir: '/instance/home' },
        expected: '/instance/home',
      },
      {
        name: 'undefined when neither home is set',
        ctx: { accountHome: undefined, homeDir: undefined },
        expected: undefined,
      },
    ])('$name', ({ ctx, expected }) => {
      expect(resolveManagementCredentialHome(ctx)).toBe(expected)
    })

    it('two credential homes never share one answer', () => {
      const a = resolveManagementCredentialHome({
        accountHome: { path: '/accounts/alice', source: 'named-instance' },
        homeDir: '/instance/home',
      })
      const b = resolveManagementCredentialHome({
        accountHome: { path: '/accounts/bob', source: 'named-instance' },
        homeDir: '/instance/home',
      })
      expect(a).toBe('/accounts/alice')
      expect(b).toBe('/accounts/bob')
      expect(a).not.toBe(b)
    })
  })

  describe('managementInventoryCacheKey isolates (machine, credential home)', () => {
    it('keys the same inputs identically', () => {
      expect(managementInventoryCacheKey('m1', '/home/a')).toBe(
        managementInventoryCacheKey('m1', '/home/a'),
      )
    })

    it.each([
      { name: 'different credential homes', a: ['m1', '/home/a'] as const, b: ['m1', '/home/b'] as const },
      { name: 'different machines', a: ['m1', '/home/a'] as const, b: ['m2', '/home/a'] as const },
      { name: 'set home vs unset home', a: ['m1', '/home/a'] as const, b: ['m1', undefined] as const },
    ])('separates $name', ({ a, b }) => {
      expect(managementInventoryCacheKey(a[0], a[1])).not.toBe(
        managementInventoryCacheKey(b[0], b[1]),
      )
    })
  })

  describe('managementLoginCommandFor resolves before any handle exists', () => {
    it.each([
      { harness: 'claude-code', cmd: 'claude', args: ['auth', 'login'] },
      { harness: 'codex', cmd: 'codex', args: ['login'] },
      { harness: 'grok', cmd: 'grok', args: ['login'] },
      { harness: 'opencode', cmd: 'opencode', args: ['auth', 'login'] },
    ])('returns the static $harness argv with no runtime', ({ harness, cmd, args }) => {
      expect(managementLoginCommandFor(harness)).toEqual({ cmd, args })
    })

    it.each(['cursor', 'shell', 'unknown-harness-xyz'])(
      'declares no login command for %s instead of substituting another harness',
      (harness) => {
        expect(managementLoginCommandFor(harness)).toBeUndefined()
      },
    )
  })

  describe('management handlers answer with no live-session services', () => {
    let seq = 0
    function managementOnlyCtx(overrides: Record<string, unknown> = {}): {
      ctx: Parameters<typeof execHandlers.usageRequest>[0]
      sent: DaemonMessage[]
    } {
      const sent: DaemonMessage[] = []
      const ctx = {
        send: (m: DaemonMessage) => sent.push(m),
        machineId: `m-mgmt-${seq++}`,
        homeDir: undefined,
        usageMemo: {},
        quotaFetcher: { getAgentQuota: async () => [] },
        ...overrides,
      } as unknown as Parameters<typeof execHandlers.usageRequest>[0]
      // The boundary proof: no bridges, observers, composer, scheduler, client
      // terminals, headless turns, screens or handle registries are present.
      expect((ctx as unknown as Record<string, unknown>).bridges).toBeUndefined()
      expect((ctx as unknown as Record<string, unknown>).observers).toBeUndefined()
      expect((ctx as unknown as Record<string, unknown>).agentRuntime).toBeUndefined()
      return { ctx, sent }
    }

    it('usage answers empty with no sessions and no harness installed', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mgmt-usage-empty-'))
      try {
        const { ctx, sent } = managementOnlyCtx({ homeDir: home })
        execHandlers.usageRequest(ctx, { type: 'usageRequest', requestId: 'u-empty' })
        await vi.waitFor(() =>
          expect(sent).toEqual([
            expect.objectContaining({ type: 'usageResult', requestId: 'u-empty', buckets: [] }),
          ]),
        )
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })

    it('usage echoes historical sources only when asked, with source attribution', async () => {
      const buckets = [{ hour: new Date('2026-09-01T10:00:00.000Z').toISOString(), model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1 }]
      const sources = [{ path: '/home/x/.claude/projects/p/s.jsonl', harness: 'claude-code', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1 }]
      const { ctx, sent } = managementOnlyCtx({
        usageMemo: { value: { atMs: Date.now(), sinceMs: 0, buckets, sources } },
      })
      execHandlers.usageRequest(
        ctx,
        { type: 'usageRequest', requestId: 'u-src', sinceMs: 0, withSources: true },
      )
      await vi.waitFor(() =>
        expect(sent).toEqual([
          expect.objectContaining({
            type: 'usageResult',
            requestId: 'u-src',
            buckets,
            sources,
            sourcesSinceMs: 0,
          }),
        ]),
      )
    })

    it('usage without withSources omits the per-file breakdown', async () => {
      const buckets = [{ hour: new Date('2026-09-01T10:00:00.000Z').toISOString(), model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1 }]
      const sources = [{ path: '/home/x/.claude/projects/p/s.jsonl', harness: 'claude-code', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1 }]
      const { ctx, sent } = managementOnlyCtx({
        usageMemo: { value: { atMs: Date.now(), sinceMs: 0, buckets, sources } },
      })
      execHandlers.usageRequest(ctx, { type: 'usageRequest', requestId: 'u-nosrc', sinceMs: 0 })
      await vi.waitFor(() =>
        expect(sent).toEqual([
          expect.objectContaining({ type: 'usageResult', requestId: 'u-nosrc', buckets }),
        ]),
      )
      expect(sent[0]).not.toHaveProperty('sources')
    })

    it('quota answers with no sessions, isolating a thrown fetcher as error', async () => {
      const { ctx, sent } = managementOnlyCtx({
        quotaFetcher: {
          getAgentQuota: async () => [
            { agent: 'codex', status: 'error', windows: [], error: 'boom', fetchedAt: new Date(0).toISOString() },
          ],
        },
      })
      execHandlers.agentQuotaRequest(ctx, { type: 'agentQuotaRequest', requestId: 'q-err' })
      await vi.waitFor(() =>
        expect(sent).toEqual([
          expect.objectContaining({ type: 'agentQuotaResult', requestId: 'q-err' }),
        ]),
      )
      expect((sent[0] as { agents: { status: string }[] }).agents[0]!.status).toBe('error')
    })

    it('quota history answers empty for an uninstalled harness instead of hanging', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mgmt-quota-empty-'))
      try {
        const { ctx, sent } = managementOnlyCtx({ homeDir: home })
        execHandlers.quotaHistoryRequest(
          ctx,
          { type: 'quotaHistoryRequest', requestId: 'qh-empty', sinceMs: 0 },
        )
        await vi.waitFor(() =>
          expect(sent).toEqual([
            expect.objectContaining({ type: 'quotaHistoryResult', requestId: 'qh-empty', samples: [] }),
          ]),
        )
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })
  })

  describe('historical closed sessions harvest without a live session', () => {
    let home = ''
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'mgmt-usage-'))
    })
    afterEach(async () => {
      await rm(home, { recursive: true, force: true })
    })

    it('scans a closed Claude transcript into hour buckets with per-file sources', async () => {
      const dir = join(home, '.claude', 'projects', '-closed-workspace')
      await mkdir(dir, { recursive: true })
      const ts = new Date('2026-09-01T10:15:00.000Z').toISOString()
      await writeFile(
        join(dir, 'closed.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          timestamp: ts,
          requestId: 'closed-req-1',
          message: {
            model: 'claude-opus-4-6',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
          },
        })}\n`,
      )
      const scan = await scanHostUsageSources({ sinceMs: 0, homeDir: home })
      expect(scan.buckets.length).toBeGreaterThan(0)
      const bucket = scan.buckets.find((b) => b.model === 'claude-opus-4-6')
      expect(bucket).toMatchObject({ inputTokens: 100, outputTokens: 50 })
      expect(scan.sources.length).toBeGreaterThan(0)
      expect(scan.sources[0]).toMatchObject({ harness: 'claude-code' })
      expect(scan.sources[0]!.models).toEqual([
        expect.objectContaining({ model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 50 }),
      ])
    })

    it('quota boot seed recovers Grok history attributed to this machine', async () => {
      const grokDir = join(home, '.grok')
      await mkdir(join(grokDir, 'logs'), { recursive: true })
      await writeFile(
        join(grokDir, 'auth.json'),
        JSON.stringify({ entry: { key: 'tok', email: 'alice@example.com' } }),
      )
      await writeFile(
        join(grokDir, 'logs', 'unified.jsonl'),
        `${JSON.stringify({
          ts: '2026-09-01T10:00:00.000Z',
          msg: 'fetched credits config',
          ctx: {
            config: {
              creditUsagePercent: 12,
              currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-25T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' },
            },
          },
        })}\n`,
      )
      const samples = await scanQuotaHistory({ sinceMs: 0, machineId: 'm-boot', homeDir: home })
      expect(samples.length).toBeGreaterThan(0)
      expect(samples[0]).toMatchObject({ agent: 'grok', machineId: 'm-boot', usedPercent: 12 })
    })
  })

  describe('inventory admission stays manifest-bound with no sessions', () => {
    const base: Inventory = {
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
      tools: [],
    }

    it('uninstalled harness advertises no server driver', () => {
      const inv: Inventory = {
        ...base,
        agents: [{ kind: 'codex', installed: false, login: { state: 'out' } }],
      }
      const drivers = runtimeDriverInventory(inv)
      expect(drivers.find((d) => d.id === 'codex-app-server')).toBeUndefined()
      expect(drivers.find((d) => d.harness === 'codex')).toMatchObject({ family: 'terminal' })
    })

    it('logged-out harness still reports its login state', async () => {
      const sent: DaemonMessage[] = []
      const loggedOut: Inventory = {
        ...base,
        agents: [{ kind: 'claude-code', installed: true, login: { state: 'out' } }],
      }
      const ctx = {
        send: (m: DaemonMessage) => sent.push(m),
        machineId: 'm-logged-out',
        homeDir: `/fake/mgmt-logged-out-${Date.now()}`,
        agentRuntime: { inventory: async () => loggedOut },
      } as unknown as Parameters<typeof reportInventory>[0]
      await reportInventory(ctx)
      const report = sent.find((m) => m.type === 'inventoryReport')
      expect(report).toMatchObject({
        inventory: { agents: [{ kind: 'claude-code', installed: true, login: { state: 'out' } }] },
      })
    })

    it('per-home reports do not share one observation', async () => {
      const sentA: DaemonMessage[] = []
      const sentB: DaemonMessage[] = []
      let builds = 0
      const invA: Inventory = { ...base, agents: [{ kind: 'codex', installed: true, version: 'v-a', login: { state: 'in' } }] }
      const invB: Inventory = { ...base, agents: [{ kind: 'codex', installed: true, version: 'v-b', login: { state: 'in' } }] }
      const mk = (home: string, inv: Inventory, sent: DaemonMessage[]) =>
        ({
          send: (m: DaemonMessage) => sent.push(m),
          machineId: 'm-shared',
          homeDir: home,
          agentRuntime: {
            inventory: async () => {
              builds += 1
              return inv
            },
          },
        }) as unknown as Parameters<typeof reportInventory>[0]
      await reportInventory(mk('/home/acct-a', invA, sentA))
      await reportInventory(mk('/home/acct-b', invB, sentB))
      expect(builds).toBe(2)
      expect(sentA.find((m) => m.type === 'inventoryReport')).toMatchObject({
        inventory: { agents: [{ version: 'v-a' }] },
      })
      expect(sentB.find((m) => m.type === 'inventoryReport')).toMatchObject({
        inventory: { agents: [{ version: 'v-b' }] },
      })
    })
  })

  describe('model probe reads the credential home, never the ambient home', () => {
    beforeEach(() => probeModels.mockReset().mockResolvedValue({}))
    afterEach(() => vi.restoreAllMocks())

    it('hands the provisioned account home to the probe', async () => {
      const sent: DaemonMessage[] = []
      const ctx = {
        send: (m: DaemonMessage) => sent.push(m),
        machineId: 'm-probe',
        homeDir: '/instance/home',
        accountHome: { path: '/accounts/alice', source: 'named-instance' },
      } as unknown as Parameters<typeof inventoryHandlers.modelProbeRequest>[0]
      inventoryHandlers.modelProbeRequest(ctx, { type: 'modelProbeRequest', requestId: 'mp-acct' })
      await vi.waitFor(() => expect(probeModels).toHaveBeenCalled())
      expect(probeModels.mock.calls[0]?.[0]).toMatchObject({
        homeDir: '/accounts/alice',
        claude: { homeDir: '/accounts/alice' },
      })
      await vi.waitFor(() =>
        expect(sent).toEqual([{ type: 'modelProbeResult', requestId: 'mp-acct', byAgent: {} }]),
      )
    })

    it('falls back to the instance home without an account home', async () => {
      const ctx = {
        send: () => {},
        machineId: 'm-probe',
        homeDir: '/instance/home',
      } as unknown as Parameters<typeof inventoryHandlers.modelProbeRequest>[0]
      inventoryHandlers.modelProbeRequest(ctx, { type: 'modelProbeRequest', requestId: 'mp-inst' })
      await vi.waitFor(() => expect(probeModels).toHaveBeenCalled())
      expect(probeModels.mock.calls[0]?.[0]).toMatchObject({
        homeDir: '/instance/home',
        claude: { homeDir: '/instance/home' },
      })
    })

    it('still answers with an empty catalog when the probe throws', async () => {
      probeModels.mockRejectedValueOnce(new Error('no cli'))
      const sent: DaemonMessage[] = []
      const ctx = {
        send: (m: DaemonMessage) => sent.push(m),
        machineId: 'm-probe',
        homeDir: '/instance/home',
      } as unknown as Parameters<typeof inventoryHandlers.modelProbeRequest>[0]
      inventoryHandlers.modelProbeRequest(ctx, { type: 'modelProbeRequest', requestId: 'mp-fail' })
      await vi.waitFor(() =>
        expect(sent).toEqual([{ type: 'modelProbeResult', requestId: 'mp-fail', byAgent: {} }]),
      )
    })
  })

  describe('native login binds the generation snapshot before any handle exists', () => {
    it('launches the verified executable with the manifest login argv and no terminal handle', async () => {
      spawned.length = 0
      const { launchSpawn } = await import('./control/session.js')
      const { testHarnessSnapshot } = await import('./test-support/harness-snapshot.js')
      const snapshot = testHarnessSnapshot({ 'claude-code': '/generation/claude' }, 7)
      const sent: DaemonMessage[] = []
      const createTerminal = vi.fn()
      const bindTerminal = vi.fn()
      const ctx = {
        send: (m: DaemonMessage) => sent.push(m),
        instanceId: 'default',
        instanceUuid: 'uuid-mgmt',
        backend: 'none',
        machineId: 'm-login',
        settingsDir: tmpdir(),
        homeDir: '/instance/home',
        launch: () => ({ cmd: '/bin/true', args: [], cwd: '/repo' }),
        harnessRuntime: {
          current: async () => snapshot,
          isCurrent: (s: unknown) => s === snapshot,
        },
        agentRuntime: {
          createTerminal,
          bindTerminal,
          handleFor: () => undefined,
          has: () => false,
          clearTerminal: () => {},
        },
        sessions: testSessions(),
            durableLabelFor: (id: string) => `podium-${id}`,
            sessionBinding: { transition: async () => ({ status: 'applied' }) },
        composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
        outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
        observers: { initSessionObservers: () => {}, clearSession: () => {}, trackedState: () => undefined },
        tailSeedGate: () => {},
        sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
        primeInjector: { reset: () => {} },
        hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
        agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
        durableSeqs: new Map(),
      } as unknown as Parameters<typeof launchSpawn>[0]
      await launchSpawn(ctx, {
        type: 'spawn',
        sessionId: 'login-pty-mgmt' as never,
        agentKind: 'shell',
        loginHarness: 'claude-code',
        cwd: '/repo',
        geometry: { cols: 80, rows: 24 },
      } as never)
      // Bound to the generation's verified executable, never a re-resolved binary.
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.cmd).toBe('/generation/claude')
      expect(spawned[0]!.args).toEqual(expect.arrayContaining(['auth', 'login']))
      // Login never creates or binds a terminal handle.
      expect(createTerminal).not.toHaveBeenCalled()
      expect(bindTerminal).not.toHaveBeenCalled()
      expect(sent.some((m) => m.type === 'bind')).toBe(true)
      expect(sent.some((m) => m.type === 'spawnError')).toBe(false)
    })

    it('throws for a harness with no native login command instead of substituting', async () => {
      const { launchSpawn } = await import('./control/session.js')
      const ctx = {
        send: () => {},
        instanceId: 'default',
        backend: 'none',
        machineId: 'm-login',
        settingsDir: tmpdir(),
        launch: () => ({ cmd: '/bin/true', args: [], cwd: '/repo' }),
        sessions: testSessions(),
            durableLabelFor: (id: string) => `podium-${id}`,
            sessionBinding: { transition: async () => ({ status: 'applied' }) },
        composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
        outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
        observers: { initSessionObservers: () => {}, clearSession: () => {}, trackedState: () => undefined },
        tailSeedGate: () => {},
        sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
        primeInjector: { reset: () => {} },
        hookEndpointFor: () => '',
        agentRelayEndpointFor: () => '',
        durableSeqs: new Map(),
      } as unknown as Parameters<typeof launchSpawn>[0]
      const sent: DaemonMessage[] = []
      ;(ctx as { send: (m: DaemonMessage) => void }).send = (m) => sent.push(m)
      await launchSpawn(ctx, {
        type: 'spawn',
        sessionId: 'login-unknown-mgmt' as never,
        agentKind: 'shell',
        loginHarness: 'unknown-harness-xyz' as never,
        cwd: '/repo',
        geometry: { cols: 80, rows: 24 },
      } as never)
      expect(sent).toEqual([
        expect.objectContaining({ type: 'spawnError', message: expect.stringContaining('does not declare') }),
      ])
    })
  })
})
