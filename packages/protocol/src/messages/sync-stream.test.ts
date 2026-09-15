import { describe, expect, it } from 'vitest'
import {
  parseSyncDeltaQuery, parseSyncRecord, SyncMeta, SyncRecord, SyncErrorReason,
  SyncBootstrapRequired, SYNC_LINE_MAX_BYTES, validateSyncDeltaChain,
  type SyncRecordLenient,
} from './sync-stream'
import { SYNC_WIRE_FIXTURES } from './sync-stream.fixtures'
import golden from './wire-golden.json'

const { URLSearchParams } = globalThis as unknown as {
  URLSearchParams: new (query: string) => { getAll(name: string): string[]; set(name: string, value: string): void }
}

const meta = SyncRecord.parse(SYNC_WIRE_FIXTURES[1]!.value)
const delta = SyncRecord.parse(SYNC_WIRE_FIXTURES[3]!.value)
const complete = SyncRecord.parse(SYNC_WIRE_FIXTURES[4]!.value)
const chain = [meta, delta, complete]

describe('HTTP sync records', () => {
  for (const fixture of SYNC_WIRE_FIXTURES) {
    it(`round trips and pins ${fixture.name}`, () => {
      const parsed = fixture.schema.parse(fixture.value)
      const line = JSON.stringify(parsed)
      expect(line).toBe(golden[fixture.name as keyof typeof golden])
      expect(parseSyncRecord(line)).toEqual({ kind: 'record', record: parsed })
    })
  }
  it('enforces meta mode and cursor requirements', () => {
    expect(SyncMeta.safeParse({ ...meta, fromSeq: undefined }).success).toBe(false)
    expect(SyncRecord.safeParse({ ...meta, fromSeq: 11 }).success).toBe(false)
    expect(SyncRecord.safeParse({ ...meta, mode: 'snapshot' }).success).toBe(false)
  })
  it('ignores unknown types and tolerates unknown entity kinds only for consumers', () => {
    expect(parseSyncRecord('{"type":"futureRecord","extra":1}')).toEqual({ kind: 'ignored', type: 'futureRecord' })
    const next = { ...delta, changes: [{ seq: 8, entity: 'futureEntity', entityId: 'x', op: 'upsert', value: { text: 'a\nb' } }] }
    expect(SyncRecord.safeParse(next).success).toBe(false)
    expect(parseSyncRecord(JSON.stringify(next)).kind).toBe('record')
    expect(parseSyncRecord(JSON.stringify({ ...next, changes: [{ ...next.changes[0], entity: 'issue' }] })).kind).toBe('refused')
  })
  it('refuses malformed JSON, malformed known records, and oversized UTF-8 lines', () => {
    expect(parseSyncRecord('{')).toEqual({ kind: 'refused', reason: 'invalid-json' })
    for (const line of ['null', '[]', '{}', '{"type":"syncComplete"}']) {
      expect(parseSyncRecord(line)).toEqual({ kind: 'refused', reason: 'invalid-record' })
    }
    const prefix = '{"type":"future","text":"'
    const suffix = '"}'
    const exact = prefix + 'x'.repeat(SYNC_LINE_MAX_BYTES - prefix.length - suffix.length) + suffix
    expect(parseSyncRecord(exact).kind).toBe('ignored')
    expect(parseSyncRecord(exact + ' ')).toEqual({ kind: 'refused', reason: 'line-too-large' })
    expect(parseSyncRecord(prefix + 'é'.repeat(SYNC_LINE_MAX_BYTES / 2) + suffix).kind).toBe('refused')
  })
  it('closes error and bootstrap refusal vocabularies', () => {
    for (const reason of SyncErrorReason.options) expect(SyncRecord.safeParse({ type: 'syncError', transferId: 't', reason }).success).toBe(true)
    expect(SyncRecord.safeParse({ type: 'syncError', transferId: 't', reason: 'other' }).success).toBe(false)
    expect(SyncBootstrapRequired.safeParse({ kind: 'bootstrap-required', reason: 'future-cursor' }).success).toBe(true)
    expect(SyncBootstrapRequired.safeParse({ kind: 'bootstrap-required', reason: 'other' }).success).toBe(false)
  })
})

describe('finite delta certificates', () => {
  it('accepts rows, watermarks, chained pages, and an already current cursor', () => {
    expect(validateSyncDeltaChain(chain)).toEqual([])
    expect(validateSyncDeltaChain([meta, { ...delta, changes: [] } as SyncRecordLenient, { ...complete, rows: 0 } as SyncRecordLenient])).toEqual([])
    expect(validateSyncDeltaChain([meta, { ...delta, seq: 7, changes: [] } as SyncRecordLenient, { ...delta, fromSeq: 7 } as SyncRecordLenient, { ...complete, records: 2 } as SyncRecordLenient])).toEqual([])
    expect(validateSyncDeltaChain([{ ...meta, fromSeq: 10 } as SyncRecordLenient, { ...complete, records: 0, rows: 0 } as SyncRecordLenient])).toEqual([])
  })
  it('rejects gaps, rows outside the certificate, and a mismatched completion cursor', () => {
    expect(validateSyncDeltaChain([meta, { ...delta, fromSeq: 6 } as SyncRecordLenient, complete])).toContain('non-chaining')
    expect(validateSyncDeltaChain([meta, { ...delta, seq: 7 } as SyncRecordLenient, complete])).toContain('row-outside-range')
    expect(validateSyncDeltaChain([meta, delta, { ...complete, seq: 9 } as SyncRecordLenient])).toContain('complete-seq-mismatch')
  })
  it('requires one meta, matching identity and counts, and exactly one successful terminal', () => {
    expect(validateSyncDeltaChain([])).toContain('meta-required')
    expect(validateSyncDeltaChain([meta, complete])).toContain('incomplete-range')
    expect(validateSyncDeltaChain([meta, meta, delta, complete])).toContain('delta-required')
    expect(validateSyncDeltaChain([meta, { ...delta, epoch: 'other' } as SyncRecordLenient, complete])).toContain('identity-mismatch')
    expect(validateSyncDeltaChain([meta, delta, { ...complete, rows: 9 } as SyncRecordLenient])).toContain('count-mismatch')
    expect(validateSyncDeltaChain([meta, delta, { ...complete, transferId: 'other' } as SyncRecordLenient])).toContain('transfer-mismatch')
    expect(validateSyncDeltaChain([meta, delta])).toContain('complete-required')
    expect(validateSyncDeltaChain([...chain, complete])).toContain('delta-required')
    expect(validateSyncDeltaChain([meta, delta, { type: 'syncError', transferId: 'transfer-1', reason: 'deadline' }])).toContain('complete-required')
  })
})

describe('delta query', () => {
  it('parses a shared full identity and optional finite target', () => {
    expect(parseSyncDeltaQuery(new URLSearchParams('feedId=f&epoch=e&from=0&to=10'))).toEqual({ success: true, data: { feedId: 'f', epoch: 'e', from: 0, to: 10 } })
    expect(parseSyncDeltaQuery(new URLSearchParams('feedId=f&epoch=e&from=10')).success).toBe(true)
  })
  it.each(['-1', '1.1', 'NaN', 'Infinity', '', '1e2', ' 1', '9007199254740992'])('rejects malformed sequence %s', (value) => {
    for (const key of ['from', 'to']) {
      const query = new URLSearchParams('feedId=f&epoch=e&from=0')
      query.set(key, value)
      expect(parseSyncDeltaQuery(query).success).toBe(false)
    }
  })
  it.each(['feedId=f&epoch=e', 'feedId=f&from=0', 'epoch=e&from=0', 'feedId=f&epoch=e&from=2&to=1', 'feedId=f&epoch=e&from=0&from=1', 'feedId=f&feedId=g&epoch=e&from=0'])('rejects missing, inverted, or duplicate query fields: %s', (query) => {
    expect(parseSyncDeltaQuery(new URLSearchParams(query)).success).toBe(false)
  })
})
