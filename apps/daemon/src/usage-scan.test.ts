import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bucketize, scanClaudeUsage, usageFromRecord } from './usage-scan'

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
    const home = mkdtempSync(join(tmpdir(), 'podium-usage-'))
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
    const home = mkdtempSync(join(tmpdir(), 'podium-usage-empty-'))
    expect(await scanClaudeUsage({ sinceMs: 0, homeDir: home })).toEqual([])
  })
})
