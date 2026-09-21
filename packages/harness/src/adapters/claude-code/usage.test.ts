import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanClaudeUsage, usageFromRecord, fetchClaudeQuota, parseClaudeUsage } from './usage.js'
import { scanHostUsageSources } from '../../inventory/usage.js'
import { UsageScanCache, fileBuckets, mergeBuckets, windowBuckets } from '../../usage-records.js'
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

/** Fold section scans the way the inventory mechanism does (file fold, window, merge). */
async function scanBuckets(opts: { sinceMs: number; homeDir: string }) {
  const scans = await scanClaudeUsage(opts)
  return mergeBuckets(scans.flatMap((scan) => windowBuckets(fileBuckets(scan), opts.sinceMs)))
}

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

describe('usageFromRecord', () => {
  it('extracts usage from assistant records only', () => {
    const rec = usageFromRecord(
      JSON.parse(assistantLine('2026-06-12T10:01:00.000Z', 'claude-sonnet-4-5', 10, 20)),
    )
    expect(rec).toMatchObject({
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      cacheCreation1hTokens: 0,
    })
    expect(usageFromRecord({ type: 'user', message: {} })).toBeNull()
    expect(usageFromRecord({ type: 'assistant', message: {} })).toBeNull()
  })

  it('skips the `<synthetic>` placeholder — no model ran and nothing was billed', () => {
    // Claude Code writes its session-limit and API-error notices as assistant
    // turns with an all-zero usage block. Harvested, they became a permanent
    // 0-token `<synthetic>` row in the usage sheet's model table and inflated
    // every reply count by however many times an agent hit a limit.
    const record = {
      type: 'assistant',
      timestamp: '2026-06-12T10:01:00.000Z',
      message: {
        model: '<synthetic>',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
    expect(usageFromRecord(record)).toBeNull()
  })

  it('splits Anthropic 5-minute and 1-hour cache creation while retaining the total', () => {
    const record = {
      type: 'assistant',
      timestamp: '2026-08-12T10:01:00.000Z',
      message: {
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_creation_input_tokens: 150,
          cache_creation: {
            ephemeral_1h_input_tokens: 100,
            ephemeral_5m_input_tokens: 50,
          },
        },
      },
    }
    expect(usageFromRecord(record)).toMatchObject({
      cacheCreationTokens: 150,
      cacheCreation1hTokens: 100,
    })
  })

  it('uses requestId, then message.id, as the stable API response identity', () => {
    const byRequest = usageFromRecord(
      JSON.parse(
        assistantLine('2026-08-12T10:01:00.000Z', 'claude-sonnet-5', 1, 2, {
          requestId: 'req-1',
          messageId: 'msg-1',
        }),
      ),
    )
    const byMessage = usageFromRecord(
      JSON.parse(
        assistantLine('2026-08-12T10:02:00.000Z', 'claude-sonnet-5', 1, 2, {
          messageId: 'msg-2',
        }),
      ),
    )
    expect(byRequest?.responseId).toBe('request:req-1')
    expect(byMessage?.responseId).toBe('message:msg-2')
  })
})
describe('scanClaudeUsage', () => {
  it('walks ~/.claude/projects and aggregates respecting sinceMs', async () => {
    const home = trackTmp('podium-usage-')
    const dir = join(home, '.claude', 'projects', '-src-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'conv.jsonl'),
      [
        assistantLine('2026-06-12T10:01:00.000Z', 'claude-sonnet-4-5', 10, 20),
        assistantLine('2026-05-01T10:01:00.000Z', 'claude-sonnet-4-5', 999, 999), // before since
        '{"type":"user","message":{"content":"hi"}}',
        'not json',
      ].join('\n'),
    )
    const buckets = await scanBuckets({
      sinceMs: Date.parse('2026-06-10T00:00:00Z'),
      homeDir: home,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 20,
      messages: 1,
    })
  })

  it('counts a repeated API response once while preserving distinct requests', async () => {
    const home = trackTmp('podium-usage-dedupe-')
    const dir = join(home, '.claude', 'projects', '-src-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'conv.jsonl'),
      [
        assistantLine('2026-06-12T10:01:00.000Z', 'claude-sonnet-5', 10, 20, {
          requestId: 'req-repeated',
          messageId: 'msg-repeated',
        }),
        assistantLine('2026-06-12T10:01:01.000Z', 'claude-sonnet-5', 10, 20, {
          requestId: 'req-repeated',
          messageId: 'msg-repeated',
        }),
        assistantLine('2026-06-12T10:01:02.000Z', 'claude-sonnet-5', 10, 20, {
          requestId: 'req-distinct',
          messageId: 'msg-distinct',
        }),
        assistantLine('2026-06-12T10:01:03.000Z', 'claude-sonnet-5', 10, 20, {
          messageId: 'msg-fallback',
        }),
        assistantLine('2026-06-12T10:01:04.000Z', 'claude-sonnet-5', 10, 20, {
          messageId: 'msg-fallback',
        }),
      ].join('\n'),
    )

    const buckets = await scanBuckets({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      hour: '2026-06-12T10:00:00.000Z',
      model: 'claude-sonnet-5',
      inputTokens: 30,
      outputTokens: 60,
      messages: 3,
    })
  })

  it('returns [] when no claude dir exists', async () => {
    const home = trackTmp('podium-usage-empty-')
    expect(await scanClaudeUsage({ sinceMs: 0, homeDir: home })).toEqual([])
  })
})
describe('the incremental cursor', () => {
  const write = (path: string, lines: string[]) => writeFileSync(path, `${lines.join('\n')}\n`)
  const append = (path: string, lines: string[]) => appendFileSync(path, `${lines.join('\n')}\n`)

  const home = () => {
    const dir = trackTmp('podium-usage-incr-')
    mkdirSync(join(dir, '.claude', 'projects', '-src-app'), { recursive: true })
    return dir
  }

  it('reaches the same totals as a cold walk after an append', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    write(path, [
      assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'r1' }),
    ])

    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })

    append(path, [
      assistantLine('2026-06-12T10:05:00.000Z', 'claude-opus-5', 30, 40, { requestId: 'r2' }),
    ])
    const warm = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    const cold = await scanHostUsageSources({ sinceMs: 0, homeDir: dir })

    expect(warm.sources[0]!.models).toEqual(cold.sources[0]!.models)
    expect(warm.buckets).toEqual(cold.buckets)
    expect(warm.sources[0]!.scannedBytes).toBe(statSync(path).size)
  })

  it('does not recount a duplicated response that straddles the cursor', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    const dup = (ts: string) =>
      assistantLine(ts, 'claude-opus-5', 10, 20, { requestId: 'same', messageId: 'same' })
    write(path, [dup('2026-06-12T10:01:00.000Z')])

    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    // The second row of the same API response, written after the first scan.
    append(path, [dup('2026-06-12T10:01:01.000Z')])
    const warm = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })

    expect(warm.sources[0]!.models[0]).toMatchObject({ inputTokens: 10, messages: 1 })
  })

  // The cursor stops at the last newline, so a record still being written is
  // counted for THIS answer and re-read — never lost, never counted twice.
  it('counts a torn final line once, before and after it is completed', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    const line = assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, {
      requestId: 'r1',
    })
    writeFileSync(path, line) // no trailing newline: a torn write

    const cache = new UsageScanCache()
    const torn = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    expect(torn.sources[0]!.models[0]).toMatchObject({ inputTokens: 10, messages: 1 })
    expect(torn.sources[0]!.scannedBytes).toBe(0)

    appendFileSync(path, '\n')
    const settled = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    expect(settled.sources[0]!.models[0]).toMatchObject({ inputTokens: 10, messages: 1 })
    expect(settled.sources[0]!.scannedBytes).toBe(statSync(path).size)
  })

  // "Transcripts are append-only" is load-bearing, and a length test alone does
  // not check it: a rewrite in place that keeps or grows the size passes it and
  // then resumes at a cursor pointing into different content.
  it('cold-reads a file rewritten in place at the SAME size', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    const line = (id: string, input: number) =>
      assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', input, 20, { requestId: id })
    write(path, [line('r1', 11), line('r2', 11)])

    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })

    // Same byte length, entirely different content — the file was rewritten.
    write(path, [line('r3', 22), line('r4', 22)])
    const warm = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    const cold = await scanHostUsageSources({ sinceMs: 0, homeDir: dir })
    expect(warm.sources[0]!.models).toEqual(cold.sources[0]!.models)
    expect(warm.sources[0]!.models[0]).toMatchObject({ inputTokens: 44, messages: 2 })
  })

  it('cold-reads a file rewritten LONGER with all-new content', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    write(path, [
      assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'r1' }),
    ])
    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })

    write(path, [
      assistantLine('2026-06-12T10:03:00.000Z', 'claude-opus-5', 5, 5, { requestId: 'x1' }),
      assistantLine('2026-06-12T10:04:00.000Z', 'claude-opus-5', 5, 5, { requestId: 'x2' }),
      assistantLine('2026-06-12T10:05:00.000Z', 'claude-opus-5', 5, 5, { requestId: 'x3' }),
    ])
    const warm = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    const cold = await scanHostUsageSources({ sinceMs: 0, homeDir: dir })
    expect(warm.sources[0]!.models).toEqual(cold.sources[0]!.models)
    expect(warm.sources[0]!.models[0]).toMatchObject({ inputTokens: 15, messages: 3 })
  })

  // The fingerprint must not defeat the cursor it guards: a file shorter than
  // the head sample still has to resume incrementally when it merely grows.
  it('still resumes incrementally on a small file that only grew', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    write(path, [
      assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'r1' }),
    ])
    const cache = new UsageScanCache()
    const first = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    const cursor = first.sources[0]!.scannedBytes
    append(path, [
      assistantLine('2026-06-12T10:02:00.000Z', 'claude-opus-5', 30, 40, { requestId: 'r2' }),
    ])
    const warm = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    const cold = await scanHostUsageSources({ sinceMs: 0, homeDir: dir })
    expect(warm.sources[0]!.scannedBytes).toBeGreaterThan(cursor)
    expect(warm.sources[0]!.models).toEqual(cold.sources[0]!.models)
  })

  it('re-reads from zero when a file shrank, rather than trusting a stale cursor', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    write(path, [
      assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'r1' }),
      assistantLine('2026-06-12T10:02:00.000Z', 'claude-opus-5', 10, 20, { requestId: 'r2' }),
    ])
    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })

    write(path, [
      assistantLine('2026-06-12T10:09:00.000Z', 'claude-opus-5', 7, 7, { requestId: 'r3' }),
    ])
    const after = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    expect(after.sources[0]!.models[0]).toMatchObject({ inputTokens: 7, messages: 1 })
  })

  it('forgets files the window has moved past instead of growing without bound', async () => {
    const dir = home()
    const path = join(dir, '.claude', 'projects', '-src-app', 'conv.jsonl')
    write(path, [assistantLine('2026-06-12T10:01:00.000Z', 'claude-opus-5', 10, 20)])
    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    expect(cache.size).toBe(1)
    await scanHostUsageSources({ sinceMs: Date.now() + 60_000, homeDir: dir, cache })
    expect(cache.size).toBe(0)
  })
})



function homeWithCreds(creds: unknown): string {
  const home = trackTmp('podium-cq-')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(creds))
  return home
}
const okBody = {
  five_hour: { utilization: 42.5, resets_at: '2026-06-19T20:00:00.000Z' },
  seven_day: { utilization: 7, resets_at: '2026-06-24T00:00:00.000Z' },
}
const genericBody = {
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 42.5,
      resets_at: '2026-06-19T20:00:00.000Z',
      scope: null,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 7,
      resets_at: '2026-06-24T00:00:00.000Z',
      scope: null,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 83,
      resets_at: '2026-06-24T00:00:00.000Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
}
const now = Date.parse('2026-06-19T18:00:00.000Z')
const future = now + 3_600_000

describe('parseClaudeUsage', () => {
  it('maps the legacy fixed fields when the generic limits array is absent', () => {
    expect(parseClaudeUsage(okBody)).toEqual([
      {
        key: '5h',
        label: '5-hour',
        usedPercent: 42.5,
        resetsAt: '2026-06-19T20:00:00.000Z',
        windowMinutes: 300,
      },
      {
        key: 'weekly',
        label: 'Weekly',
        usedPercent: 7,
        resetsAt: '2026-06-24T00:00:00.000Z',
        windowMinutes: 10080,
      },
    ])
  })

  it('maps every generic limit and uses the upstream scoped display name', () => {
    expect(parseClaudeUsage(genericBody)).toEqual([
      {
        key: 'session',
        label: '5-hour',
        usedPercent: 42.5,
        resetsAt: '2026-06-19T20:00:00.000Z',
        windowMinutes: 300,
      },
      {
        key: 'weekly-all',
        label: 'Weekly',
        usedPercent: 7,
        resetsAt: '2026-06-24T00:00:00.000Z',
        windowMinutes: 10080,
      },
      {
        key: 'weekly-scoped:model:fable',
        label: 'Fable',
        usedPercent: 83,
        resetsAt: '2026-06-24T00:00:00.000Z',
        windowMinutes: 10080,
        // POD-271: the model scope is named on the wire, so the UI can tell a
        // limit that gates the harness from one it can fall back off.
        scopeModel: 'Fable',
      },
    ])
  })

  it('leaves unscoped limits without a model, and names the model on scoped ones', () => {
    const windows = parseClaudeUsage(genericBody)
    expect(windows.map((w) => w.scopeModel)).toEqual([undefined, undefined, 'Fable'])
  })

  it('does not treat a surface-only scope as a model scope', () => {
    expect(
      parseClaudeUsage({
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 20,
            resets_at: '2026-06-24T00:00:00.000Z',
            scope: { model: null, surface: { id: 'code', display_name: 'Claude Code' } },
          },
        ],
      })[0],
    ).toEqual({
      key: 'weekly-scoped:surface:code',
      label: 'Claude Code',
      usedPercent: 20,
      resetsAt: '2026-06-24T00:00:00.000Z',
      windowMinutes: 10080,
    })
  })

  it('tolerates a removed scoped limit and displays an unknown replacement generically', () => {
    expect(
      parseClaudeUsage({
        limits: [
          genericBody.limits[0],
          {
            kind: 'burst_scoped',
            group: 'burst',
            percent: 12.34,
            resets_at: '2026-06-20T00:00:00.000Z',
            scope: { model: { id: 'model-7', display_name: 'Quasar' } },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ key: 'session', label: '5-hour' }),
      {
        key: 'burst-scoped:model:model-7',
        label: 'Quasar',
        usedPercent: 12.3,
        resetsAt: '2026-06-20T00:00:00.000Z',
        windowMinutes: 0,
        scopeModel: 'Quasar',
      },
    ])
  })

  it('falls back to legacy fields when a malformed limits array has no usable entries', () => {
    expect(parseClaudeUsage({ ...okBody, limits: [null, { kind: 'weekly_scoped' }] })).toEqual(
      parseClaudeUsage(okBody),
    )
  })
})

describe('fetchClaudeQuota', () => {
  it('is unauthenticated when no credentials file exists', async () => {
    const home = trackTmp('podium-cq-')
    const r = await fetchClaudeQuota({ homeDir: home, now })
    expect(r).toMatchObject({ agent: 'claude-code', status: 'unauthenticated', windows: [] })
  })

  it('is expired (no network call) when the token is past expiry', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: now - 1 } })
    let called = false
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => {
        called = true
        return new Response('', { status: 200 })
      }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r.status).toBe('expired')
  })

  it('returns ok windows on a 200 with a valid token', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(genericBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.label)).toEqual(['5-hour', 'Weekly', 'Fable'])
  })

  it('maps 401 to expired and other failures to error', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r401 = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
    })
    expect(r401.status).toBe('expired')
    const r500 = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
    })
    expect(r500.status).toBe('error')
  })

  it('populates the account email (from ~/.claude.json) and plan (subscriptionType)', async () => {
    const home = homeWithCreds({
      claudeAiOauth: { accessToken: 't', expiresAt: future, subscriptionType: 'max' },
    })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }),
    )
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.account).toEqual({ email: 'me@example.com', plan: 'max' })
  })

  it('still carries the account on an expired token so the overlay can label it', async () => {
    const home = homeWithCreds({
      claudeAiOauth: { accessToken: 't', expiresAt: now - 1, subscriptionType: 'max' },
    })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }),
    )
    const r = await fetchClaudeQuota({ homeDir: home, now })
    expect(r.status).toBe('expired')
    expect(r.account?.email).toBe('me@example.com')
  })

  it('omits the account when ~/.claude.json is absent and no plan is known', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.account).toBeUndefined()
  })
})
