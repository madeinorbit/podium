import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UsageBucketWire } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import { bucketize, mergeBuckets } from './usage-records.js'
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
