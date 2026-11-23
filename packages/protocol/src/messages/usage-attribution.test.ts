import { describe, expect, it } from 'vitest'
import { UsageResultMessage } from './host.js'

const bucket = {
  hour: '2026-11-01T12:00:00.000Z',
  model: 'fixture-model',
  inputTokens: 20,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messages: 1,
}
const source = {
  path: '/fixture/transcript.jsonl',
  harness: 'claude-code',
  scannedBytes: 200,
  firstTsMs: 1_793_534_400_000,
  lastTsMs: 1_793_534_400_000,
  models: [],
  windowModels: [],
}
const result = {
  type: 'usageResult',
  requestId: 'usage-attribution',
  hostname: 'fixture-machine',
  buckets: [bucket],
  sources: [source],
}

describe('usage source wire compatibility', () => {
  it('accepts an older daemon without source hourly attribution', () => {
    expect(UsageResultMessage.parse(result)).toEqual(result)
  })

  it('preserves modern source hourly attribution through the actual daemon message parser', () => {
    const modern = { ...result, sources: [{ ...source, windowBuckets: [bucket] }] }
    expect(JSON.stringify(UsageResultMessage.parse(modern))).toBe(JSON.stringify(modern))
  })
})
