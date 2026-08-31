import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UsageBucketWire } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bucketize,
  codexModelOf,
  codexUsageFromRecord,
  grokUsageFromSession,
  mergeBuckets,
  scanClaudeUsage,
  scanCodexUsage,
  scanGrokUsage,
  scanHostUsage,
  scanHostUsageSources,
  UsageScanCache,
  usageFromRecord,
} from './usage-scan'

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

describe('bucketize', () => {
  it('folds records into hour x model buckets, sorted by hour', () => {
    const rec = (ts: string, model: string, input: number, output: number) => ({
      tsMs: Date.parse(ts),
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
    })
    const buckets = bucketize([
      rec('2026-06-12T10:05:00Z', 'a', 1, 2),
      rec('2026-06-12T10:55:00Z', 'a', 1, 2),
      rec('2026-06-12T09:55:00Z', 'b', 5, 0),
    ])
    expect(buckets).toHaveLength(2)
    expect(buckets[0]).toMatchObject({
      hour: '2026-06-12T09:00:00.000Z',
      model: 'b',
      inputTokens: 5,
      messages: 1,
    })
    expect(buckets[1]).toMatchObject({
      hour: '2026-06-12T10:00:00.000Z',
      model: 'a',
      inputTokens: 2,
      outputTokens: 4,
      messages: 2,
    })
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
    const buckets = await scanClaudeUsage({
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

    const buckets = await scanClaudeUsage({ sinceMs: 0, homeDir: home })
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

// ── Codex (POD-570). Shapes below are copied from real
// ~/.codex/sessions/**/rollout-*.jsonl records (codex-cli 0.146.1).

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

describe('codexModelOf', () => {
  it('reads the model off turn_context and ignores every other record', () => {
    expect(codexModelOf(JSON.parse(turnContextLine('gpt-5.6-sol')))).toBe('gpt-5.6-sol')
    expect(codexModelOf(JSON.parse(tokenCountLine('2026-06-12T10:00:00Z', LAST)))).toBeUndefined()
    expect(codexModelOf({ type: 'turn_context', payload: {} })).toBeUndefined()
    expect(codexModelOf(null)).toBeUndefined()
  })
})

describe('codexUsageFromRecord', () => {
  it('unpacks cached_input_tokens out of input_tokens so it is not billed twice', () => {
    const rec = codexUsageFromRecord(
      JSON.parse(tokenCountLine('2026-06-12T10:01:00.000Z', LAST)),
      'gpt-5.6-sol',
    )
    expect(rec).toEqual({
      tsMs: Date.parse('2026-06-12T10:01:00.000Z'),
      model: 'gpt-5.6-sol',
      // 21506 total input − 18176 cached: the remainder billed at full rate.
      inputTokens: 3_330,
      // reasoning_output_tokens (105) is already inside output_tokens.
      outputTokens: 445,
      cacheReadTokens: 18_176,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
    })
  })

  it('accepts the older cache_read_input_tokens spelling', () => {
    const rec = codexUsageFromRecord(
      JSON.parse(
        tokenCountLine('2026-06-12T10:01:00.000Z', {
          input_tokens: 1_000,
          cache_read_input_tokens: 600,
          output_tokens: 10,
        }),
      ),
      'gpt-5',
    )
    expect(rec).toMatchObject({ inputTokens: 400, cacheReadTokens: 600 })
  })

  it('clamps a cached count that exceeds its input rather than going negative', () => {
    const rec = codexUsageFromRecord(
      JSON.parse(
        tokenCountLine('2026-06-12T10:01:00.000Z', {
          input_tokens: 100,
          cached_input_tokens: 5_000,
          output_tokens: 1,
        }),
      ),
      'gpt-5',
    )
    expect(rec).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 })
  })

  it('ignores a token_count carrying no last_token_usage, and other records', () => {
    expect(
      codexUsageFromRecord(JSON.parse(tokenCountLine('2026-06-12T10:00:00Z', null)), 'gpt-5'),
    ).toBeNull()
    expect(codexUsageFromRecord(JSON.parse(turnContextLine('gpt-5')), 'gpt-5')).toBeNull()
    expect(codexUsageFromRecord({ type: 'response_item' }, 'gpt-5')).toBeNull()
  })
})

describe('scanCodexUsage', () => {
  const writeRollout = (home: string, name: string, lines: string[]): void => {
    const dir = join(home, '.codex', 'sessions', '2026', '06', '12')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), lines.join('\n'))
  }

  it('walks the nested date dirs, carrying the model forward from turn_context', async () => {
    const home = trackTmp('podium-usage-codex-')
    writeRollout(home, 'rollout-a.jsonl', [
      '{"type":"session_meta","payload":{"id":"abc","source":"cli"}}',
      turnContextLine('gpt-5.6-sol'),
      tokenCountLine('2026-06-12T10:01:00.000Z', LAST),
      tokenCountLine('2026-06-12T10:44:00.000Z', LAST),
      tokenCountLine('2026-05-01T10:01:00.000Z', LAST), // before since
      'not json',
    ])
    const buckets = await scanCodexUsage({
      sinceMs: Date.parse('2026-06-10T00:00:00Z'),
      homeDir: home,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      hour: '2026-06-12T10:00:00.000Z',
      model: 'gpt-5.6-sol',
      inputTokens: 6_660,
      outputTokens: 890,
      cacheReadTokens: 36_352,
      messages: 2,
    })
  })

  it('follows a mid-session model switch', async () => {
    const home = trackTmp('podium-usage-codex-switch-')
    writeRollout(home, 'rollout-b.jsonl', [
      turnContextLine('gpt-5.6-sol'),
      tokenCountLine('2026-06-12T10:01:00.000Z', LAST),
      turnContextLine('gpt-5-mini'),
      tokenCountLine('2026-06-12T10:02:00.000Z', LAST),
    ])
    // Same hour, so both land in one hour with a bucket each — the switch is
    // visible as two models, not one model charged for both turns.
    const buckets = await scanCodexUsage({ sinceMs: 0, homeDir: home })
    expect(buckets.map((b) => b.model).sort()).toEqual(['gpt-5-mini', 'gpt-5.6-sol'])
    expect(buckets.every((b) => b.messages === 1)).toBe(true)
  })

  it('attributes usage to unknown when a rollout names no model at all', async () => {
    const home = trackTmp('podium-usage-codex-nomodel-')
    writeRollout(home, 'rollout-c.jsonl', [tokenCountLine('2026-06-12T10:01:00.000Z', LAST)])
    const buckets = await scanCodexUsage({ sinceMs: 0, homeDir: home })
    expect(buckets[0]).toMatchObject({ model: 'unknown', messages: 1 })
  })

  it('returns [] when no codex dir exists', async () => {
    const home = trackTmp('podium-usage-codex-empty-')
    expect(await scanCodexUsage({ sinceMs: 0, homeDir: home })).toEqual([])
  })
})

describe('mergeBuckets', () => {
  it('sums same hour+model across harnesses and sorts by hour', () => {
    const b = (hour: string, model: string, input: number): UsageBucketWire => ({
      hour,
      model,
      inputTokens: input,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
      cacheCreation1hTokens: 1,
      messages: 1,
    })
    const merged = mergeBuckets([
      b('2026-06-12T10:00:00.000Z', 'shared', 10),
      b('2026-06-12T09:00:00.000Z', 'other', 5),
      b('2026-06-12T10:00:00.000Z', 'shared', 7),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ hour: '2026-06-12T09:00:00.000Z', inputTokens: 5 })
    expect(merged[1]).toMatchObject({
      inputTokens: 17,
      messages: 2,
      cacheCreationTokens: 6,
      cacheCreation1hTokens: 2,
    })
  })
})

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

describe('grokUsageFromSession', () => {
  it('reads context tokens, reply count, model, and last-active from the session snapshot', () => {
    const rec = grokUsageFromSession(
      {
        contextTokensUsed: 50_593,
        assistantMessageCount: 5,
        turnCount: 1,
        primaryModelId: 'grok-4.6',
        modelsUsed: ['grok-4.6'],
      },
      {
        info: { id: 'sess-1' },
        current_model_id: 'grok-4.6-build',
        last_active_at: '2026-08-13T05:46:27.505Z',
      },
      Date.parse('2026-08-13T00:00:00.000Z'),
    )
    expect(rec).toEqual({
      tsMs: Date.parse('2026-08-13T05:46:27.505Z'),
      model: 'grok-4.6',
      inputTokens: 50_593,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      messages: 5,
      responseId: 'grok-session:sess-1',
    })
  })

  it('falls back to current_model_id and file mtime when signals omit them', () => {
    const rec = grokUsageFromSession(
      { contextTokensUsed: 100, turnCount: 2 },
      { current_model_id: 'grok-4.5', updated_at: '2026-08-01T12:00:00.000Z' },
      0,
    )
    expect(rec).toMatchObject({
      model: 'grok-4.5',
      inputTokens: 100,
      messages: 2,
      tsMs: Date.parse('2026-08-01T12:00:00.000Z'),
    })
  })

  it('skips a snapshot with no tokens and no turns', () => {
    expect(grokUsageFromSession({ contextTokensUsed: 0, turnCount: 0 }, {}, 1)).toBeNull()
    expect(grokUsageFromSession(null, {}, 1)).toBeNull()
  })
})

describe('scanGrokUsage', () => {
  it('walks ~/.grok/sessions and keeps sessions inside the window', async () => {
    const home = trackTmp('podium-usage-grok-')
    writeGrokSession(
      home,
      'keep',
      { contextTokensUsed: 1_000, assistantMessageCount: 3, primaryModelId: 'grok-4.6' },
      {
        info: { id: 'keep' },
        last_active_at: '2026-06-12T10:15:00.000Z',
      },
    )
    writeGrokSession(
      home,
      'old',
      { contextTokensUsed: 9_999, assistantMessageCount: 9, primaryModelId: 'grok-4.6' },
      {
        info: { id: 'old' },
        last_active_at: '2026-05-01T10:00:00.000Z',
      },
    )

    const buckets = await scanGrokUsage({
      sinceMs: Date.parse('2026-06-10T00:00:00Z'),
      homeDir: home,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      hour: '2026-06-12T10:00:00.000Z',
      model: 'grok-4.6',
      inputTokens: 1_000,
      outputTokens: 0,
      messages: 3,
    })
  })

  it('still harvests a session whose summary.json is missing', async () => {
    const home = trackTmp('podium-usage-grok-nosummary-')
    writeGrokSession(home, 'bare', {
      contextTokensUsed: 40,
      assistantMessageCount: 1,
      primaryModelId: 'grok-4.5',
    })
    const buckets = await scanGrokUsage({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ model: 'grok-4.5', inputTokens: 40, messages: 1 })
  })

  it('returns [] when no grok dir exists', async () => {
    const home = trackTmp('podium-usage-grok-empty-')
    expect(await scanGrokUsage({ sinceMs: 0, homeDir: home })).toEqual([])
  })

  it('does not harvest a signals.json buried in terminal logs', async () => {
    const home = trackTmp('podium-usage-grok-logs-')
    writeGrokSession(home, 'keep', {
      contextTokensUsed: 10,
      assistantMessageCount: 1,
      primaryModelId: 'grok-4.6',
    })
    const decoy = join(home, '.grok', 'sessions', '%2Fsrc', 'keep', 'terminal')
    mkdirSync(decoy, { recursive: true })
    writeFileSync(
      join(decoy, 'signals.json'),
      JSON.stringify({
        contextTokensUsed: 99_999,
        assistantMessageCount: 50,
        primaryModelId: 'grok-4.6',
      }),
    )

    const buckets = await scanGrokUsage({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ inputTokens: 10, messages: 1 })
  })

  it('includes a subagent session snapshot', async () => {
    const home = trackTmp('podium-usage-grok-sub-')
    writeGrokSession(home, 'parent', {
      contextTokensUsed: 20,
      assistantMessageCount: 1,
      primaryModelId: 'grok-4.6',
    })
    const child = join(home, '.grok', 'sessions', '%2Fsrc', 'parent', 'subagents', 'child')
    mkdirSync(child, { recursive: true })
    writeFileSync(
      join(child, 'signals.json'),
      JSON.stringify({
        contextTokensUsed: 30,
        assistantMessageCount: 2,
        primaryModelId: 'grok-4.6',
      }),
    )

    const buckets = await scanGrokUsage({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ model: 'grok-4.6', inputTokens: 50, messages: 3 })
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

// ── POD-1858: the per-FILE half of the same walk ────────────────────────────

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

  it('carries the Codex model across the seam a turn_context sits behind', async () => {
    const dir = trackTmp('podium-usage-incr-codex-')
    const codexDir = join(dir, '.codex', 'sessions', '2026', '06', '12')
    mkdirSync(codexDir, { recursive: true })
    const path = join(codexDir, 'rollout-a.jsonl')
    write(path, [turnContextLine('gpt-5.6-sol'), tokenCountLine('2026-06-12T10:01:00.000Z', LAST)])

    const cache = new UsageScanCache()
    await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })
    append(path, [tokenCountLine('2026-06-12T10:02:00.000Z', LAST)])
    const warm = await scanHostUsageSources({ sinceMs: 0, homeDir: dir, cache })

    expect(warm.sources[0]!.models.map((m) => m.model)).toEqual(['gpt-5.6-sol'])
    expect(warm.sources[0]!.models[0]).toMatchObject({ messages: 2 })
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
