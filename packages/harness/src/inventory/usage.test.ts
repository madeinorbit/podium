import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKind, AgentQuotaWire } from '@podium/model'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeQuotaFetcher, scanHostUsage, scanHostUsageSources } from './usage.js'

// POD-518 [spec:SP-0be7]: every mkdtemp in this file is tracked and removed when the file's
// tests finish, so a suite run leaves nothing behind in tmp.
const tmpDirs: string[] = []
function trackTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const assistantLine = (
  ts: string,
  model: string,
  input: number,
  output: number,
  ids: { requestId?: string; messageId?: string } = {},
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    ...(ids.requestId ? { requestId: ids.requestId } : {}),
    message: {
      model,
      ...(ids.messageId ? { id: ids.messageId } : {}),
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    },
  })

const turnContextLine = (model: string) =>
  JSON.stringify({
    timestamp: '2026-08-06T22:03:51.610Z',
    type: 'turn_context',
    payload: { turn_id: 't1', cwd: '/src/app', model, effort: 'high' },
  })

const tokenCountLine = (
  ts: string,
  last: Record<string, number> | null,
  total?: Record<string, number>,
) =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        ...(last ? { last_token_usage: last } : {}),
        total_token_usage: total ?? last ?? {},
        model_context_window: 258_400,
      },
    },
  })

const LAST = {
  input_tokens: 21_506,
  cached_input_tokens: 18_176,
  cache_write_input_tokens: 0,
  output_tokens: 445,
  reasoning_output_tokens: 105,
  total_tokens: 21_951,
}

function writeGrokSession(
  home: string,
  id: string,
  signals: Record<string, unknown>,
  summary?: Record<string, unknown>,
): void {
  const dir = join(home, '.grok', 'sessions', '%2Fsrc', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'signals.json'), JSON.stringify(signals))
  if (summary) writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary))
}

const wire = (agent: AgentKind, status: AgentQuotaWire['status']): AgentQuotaWire => ({
  agent,
  status,
  windows: [],
  fetchedAt: '2026-06-19T18:00:00.000Z',
})

describe('makeQuotaFetcher', () => {
  it('aggregates all fetchers and isolates a thrown fetcher as error', async () => {
    const f = makeQuotaFetcher({
      fetchers: [
        { key: 'claude-code', fetch: async () => wire('claude-code', 'ok') },
        {
          key: 'codex',
          fetch: async () => {
            throw new Error('boom')
          },
        },
      ],
    })
    const r = await f.getAgentQuota()
    expect(r.map((x) => [x.agent, x.status])).toEqual([
      ['claude-code', 'ok'],
      ['codex', 'error'],
    ])
    expect(r[1]?.error).toContain('boom')
  })

  it('serves a cached value within TTL and refetches after it / on refresh', async () => {
    let t = 1000
    const spy = vi.fn(async () => wire('claude-code', 'ok'))
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ key: 'claude-code', fetch: spy }],
    })
    await f.getAgentQuota() // miss → 1 call
    t = 1050
    await f.getAgentQuota() // within TTL → cached
    expect(spy).toHaveBeenCalledTimes(1)
    await f.getAgentQuota(true) // refresh bypasses cache
    expect(spy).toHaveBeenCalledTimes(2)
    t = 1200
    await f.getAgentQuota() // TTL elapsed → refetch
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('uses a default TTL longer than the 60s client poll so the memo survives a poll', async () => {
    // The client polls every 60s; at a 60s TTL the memo is always exactly stale by
    // the next poll and re-fetches every time. The default TTL must exceed 60s so a
    // second call within the poll window is served from the memo.
    let t = 0
    const spy = vi.fn(async () => wire('claude-code', 'ok'))
    const f = makeQuotaFetcher({
      // no ttlMs override → exercises DEFAULT_TTL_MS
      now: () => t,
      fetchers: [{ key: 'claude-code', fetch: spy }],
    })
    await f.getAgentQuota() // miss → 1 call
    t = 60_000 // a full client poll interval later
    await f.getAgentQuota() // still within the default TTL → served from memo
    expect(spy).toHaveBeenCalledTimes(1)
    t = 120_000 // at the TTL boundary → memo expired → refetch
    await f.getAgentQuota()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('serves the STALE value immediately once the TTL lapses and refreshes behind it', async () => {
    // POD-1624: the whole cost of quota.summary is three live vendor HTTP calls
    // (measured on ludovico: claude 239-479ms, codex 349-537ms, grok 535-1171ms,
    // run concurrently). A plain TTL memo still makes ONE caller every 120s pay
    // that latency in full — that caller is the top bar on a page load, which is
    // exactly the freeze this issue is about. Past the TTL we must hand back the
    // last good value at once and let the refetch land out of band.
    let t = 1000
    let release: (w: AgentQuotaWire) => void = () => {}
    const spy = vi.fn(
      () =>
        new Promise<AgentQuotaWire>((resolve) => {
          release = resolve
        }),
    )
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ key: 'claude-code', fetch: spy }],
    })
    const cold = f.getAgentQuota() // nothing cached → must block
    release({ ...wire('claude-code', 'ok'), fetchedAt: 'first' })
    expect((await cold)[0]?.fetchedAt).toBe('first')

    t = 1200 // TTL lapsed → stale, but a value exists
    const stale = await f.getAgentQuota() // must NOT wait on the pending fetch
    expect(stale[0]?.fetchedAt).toBe('first')
    expect(spy).toHaveBeenCalledTimes(2) // refresh was kicked off behind it

    release({ ...wire('claude-code', 'ok'), fetchedAt: 'second' })
    await vi.waitFor(async () => expect((await f.getAgentQuota())[0]?.fetchedAt).toBe('second'))
  })

  it('collapses concurrent stale refreshes into one in-flight fetch', async () => {
    let t = 1000
    let calls = 0
    const spy = vi.fn(async () => {
      calls += 1
      return { ...wire('claude-code', 'ok'), fetchedAt: `v${calls}` }
    })
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ key: 'claude-code', fetch: spy }],
    })
    await f.getAgentQuota()
    t = 1200
    await Promise.all([f.getAgentQuota(), f.getAgentQuota(), f.getAgentQuota()])
    // three stale reads, one refresh — not a stampede of vendor calls
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not cache an errored fetcher (retries on the next call within TTL)', async () => {
    let t = 1000
    const spy = vi.fn(async () => {
      throw new Error('blip')
    })
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ key: 'claude-code', fetch: spy }],
    })
    const r1 = await f.getAgentQuota()
    expect(r1[0]?.status).toBe('error')
    t = 1050 // still within TTL
    await f.getAgentQuota()
    expect(spy).toHaveBeenCalledTimes(2) // re-invoked because the error was not cached
  })
})

describe('scanHostUsage', () => {
  it('returns every harness from one home, in one hour-sorted set', async () => {
    const home = trackTmp('podium-usage-host-')
    const claudeDir = join(home, '.claude', 'projects', '-src-app')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'conv.jsonl'),
      assistantLine('2026-06-12T11:01:00.000Z', 'claude-sonnet-4-5', 10, 20),
    )
    const codexDir = join(home, '.codex', 'sessions', '2026', '06', '12')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'rollout-a.jsonl'),
      [turnContextLine('gpt-5.6-sol'), tokenCountLine('2026-06-12T10:01:00.000Z', LAST)].join('\n'),
    )
    writeGrokSession(
      home,
      'g1',
      { contextTokensUsed: 80, assistantMessageCount: 2, primaryModelId: 'grok-4.6' },
      { last_active_at: '2026-06-12T09:30:00.000Z' },
    )

    const buckets = await scanHostUsage({ sinceMs: 0, homeDir: home })
    expect(buckets.map((b) => b.model)).toEqual(['grok-4.6', 'gpt-5.6-sol', 'claude-sonnet-4-5'])
  })

  it('still reports the harness that scanned when the other box is bare', async () => {
    const home = trackTmp('podium-usage-host-partial-')
    const codexDir = join(home, '.codex', 'sessions', '2026', '06', '12')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'rollout-a.jsonl'),
      [turnContextLine('gpt-5'), tokenCountLine('2026-06-12T10:01:00.000Z', LAST)].join('\n'),
    )
    const buckets = await scanHostUsage({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ model: 'gpt-5' })
  })
})
describe('scanHostUsageSources', () => {
  it('carries the path, the harness and the byte cursor out of the walk', async () => {
    const home = trackTmp('podium-usage-sources-')
    const dir = join(home, '.claude', 'projects', '-src-app')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'conv.jsonl')
    writeFileSync(
      path,
      `${[
        assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'r1' }),
        assistantLine('2026-06-12T11:01:00.000Z', 'claude-opus-5', 30, 40, { requestId: 'r2' }),
      ].join('\n')}\n`,
    )

    const { buckets, sources } = await scanHostUsageSources({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(2) // two hours
    expect(sources).toHaveLength(1)
    const source = sources[0]!
    expect(source.path).toBe(path)
    expect(source.harness).toBe('claude-code')
    expect(source.scannedBytes).toBe(statSync(path).size)
    expect(source.models).toEqual([
      expect.objectContaining({ model: 'claude-opus-5', inputTokens: 40, messages: 2 }),
    ])
  })

  it('folds the window and the whole file separately — the durable row outlives the window', async () => {
    const home = trackTmp('podium-usage-window-')
    const dir = join(home, '.claude', 'projects', '-src-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'conv.jsonl'),
      `${[
        assistantLine('2026-05-01T10:01:00.000Z', 'claude-opus-5', 999, 999, { requestId: 'old' }),
        assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'new' }),
      ].join('\n')}\n`,
    )

    const { sources } = await scanHostUsageSources({
      sinceMs: Date.parse('2026-06-10T00:00:00Z'),
      homeDir: home,
    })
    const source = sources[0]!
    expect(source.models[0]).toMatchObject({ inputTokens: 1_009, messages: 2 })
    expect(source.windowModels[0]).toMatchObject({ inputTokens: 10, messages: 1 })
  })

  // The subagent transcripts the one-level read used to miss. On the real box
  // they carried $85 of Claude spend in a single 7-day window.
  it('reads a delegate transcript under <nativeId>/subagents/', async () => {
    const home = trackTmp('podium-usage-subagents-')
    const dir = join(home, '.claude', 'projects', '-src-app', 'parent-1', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      `${assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20)}\n`,
    )
    const { sources } = await scanHostUsageSources({ sinceMs: 0, homeDir: home })
    expect(sources.map((s) => s.path)).toEqual([join(dir, 'agent-a1.jsonl')])
  })
})

describe('registry quota fan-out', () => {
  it('builds one fetcher per harness with a quota probe, in registry order', async () => {
    // A bare home holds no credential for any harness, so every probe answers
    // `unauthenticated` without touching the network — the fan-out itself is
    // what this pins, not the vendor endpoints.
    const home = trackTmp('podium-quota-fanout-')
    const wires = await makeQuotaFetcher({ homeDir: home }).getAgentQuota()
    expect(wires.map((wire) => [wire.agent, wire.status])).toEqual([
      ['claude-code', 'unauthenticated'],
      ['codex', 'unauthenticated'],
      ['grok', 'unauthenticated'],
    ])
  })
})
