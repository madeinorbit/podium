import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UsageBucketWire } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bucketize,
  codexModelOf,
  codexUsageFromRecord,
  mergeBuckets,
  scanClaudeUsage,
  scanCodexUsage,
  scanHostUsage,
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

const assistantLine = (ts: string, model: string, input: number, output: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
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
    })
    expect(usageFromRecord({ type: 'user', message: {} })).toBeNull()
    expect(usageFromRecord({ type: 'assistant', message: {} })).toBeNull()
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
      messages: 1,
    })
    const merged = mergeBuckets([
      b('2026-06-12T10:00:00.000Z', 'shared', 10),
      b('2026-06-12T09:00:00.000Z', 'other', 5),
      b('2026-06-12T10:00:00.000Z', 'shared', 7),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ hour: '2026-06-12T09:00:00.000Z', inputTokens: 5 })
    expect(merged[1]).toMatchObject({ inputTokens: 17, messages: 2, cacheCreationTokens: 6 })
  })
})

describe('scanHostUsage', () => {
  it('returns both harnesses from one home, in one hour-sorted set', async () => {
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

    const buckets = await scanHostUsage({ sinceMs: 0, homeDir: home })
    expect(buckets.map((b) => b.model)).toEqual(['gpt-5.6-sol', 'claude-sonnet-4-5'])
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
