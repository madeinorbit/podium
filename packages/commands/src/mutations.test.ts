import { describe, expect, it } from 'vitest'
import {
  MUTATION_RESULT_KINDS,
  MutationEnvelope,
  MutationResult,
  type MutationResultKind,
} from './mutations'

describe('MutationEnvelope', () => {
  const envelope = {
    mutationId: 'mut-1',
    command: 'issues.close',
    input: { id: 'podium-7', reason: 'done' },
    origin: { actor: 'operator', machineId: 'm1' },
    sentAt: '2026-07-09T12:00:00Z',
  }

  it('round-trips a full envelope', () => {
    expect(MutationEnvelope.parse(envelope)).toEqual(envelope)
  })

  it('allows origin.machineId to be absent (hub-local writes have no machine)', () => {
    const { machineId: _dropped, ...origin } = envelope.origin
    expect(MutationEnvelope.parse({ ...envelope, origin }).origin.machineId).toBeUndefined()
  })

  it('accepts any input payload (P3 registry validates per-command)', () => {
    expect(MutationEnvelope.parse({ ...envelope, input: undefined }).input).toBeUndefined()
    expect(MutationEnvelope.parse({ ...envelope, input: 'raw' }).input).toBe('raw')
  })

  it.each([
    ['empty mutationId', { mutationId: '' }],
    ['empty command', { command: '' }],
    ['empty actor', { origin: { actor: '' } }],
    ['non-ISO sentAt', { sentAt: 'yesterday' }],
    ['numeric sentAt', { sentAt: 1720526400000 }],
  ])('rejects %s', (_label, patch) => {
    expect(MutationEnvelope.safeParse({ ...envelope, ...patch }).success).toBe(false)
  })
})

describe('MutationResult', () => {
  it('round-trips applied with an oplog echo', () => {
    const applied = {
      kind: 'applied' as const,
      changes: [{ seq: 7, entity: 'issue' as const, id: 'podium-7', op: 'remove' as const }],
    }
    expect(MutationResult.parse(applied)).toEqual(applied)
  })

  it('round-trips applied without changes (echo is optional)', () => {
    expect(MutationResult.parse({ kind: 'applied' })).toEqual({ kind: 'applied' })
  })

  it('round-trips rejected with its reason', () => {
    const rejected = { kind: 'rejected' as const, reason: 'FORBIDDEN: role gate' }
    expect(MutationResult.parse(rejected)).toEqual(rejected)
  })

  it('rejected requires a reason', () => {
    expect(MutationResult.safeParse({ kind: 'rejected' }).success).toBe(false)
  })

  it('round-trips queued', () => {
    expect(MutationResult.parse({ kind: 'queued' })).toEqual({ kind: 'queued' })
  })

  it('rejects unknown kinds', () => {
    expect(MutationResult.safeParse({ kind: 'retrying' }).success).toBe(false)
  })

  it('the union is total over MUTATION_RESULT_KINDS (type-level)', () => {
    // Same style as message-class.ts: a table keyed by the union's discriminant
    // must satisfy Record over the kind list — adding a result arm without
    // classifying it here (or growing the list without an arm) breaks compile.
    const RETRYABLE = {
      applied: false,
      rejected: false, // definitive — poison on replay, never retried
      queued: true, // pending — the outbox replay resolves it
    } as const satisfies Record<MutationResult['kind'], boolean>
    const kinds: readonly MutationResultKind[] = MUTATION_RESULT_KINDS
    for (const kind of kinds) expect(kind in RETRYABLE).toBe(true)
    // And the discriminant union is exactly the const list's element type.
    const _check: Record<MutationResult['kind'], true> = {
      applied: true,
      rejected: true,
      queued: true,
    } satisfies Record<MutationResultKind, true>
    expect(Object.keys(_check).sort()).toEqual([...MUTATION_RESULT_KINDS].sort())
  })
})

describe('applied.result (Codex round-2)', () => {
  it('the applied arm carries an arbitrary command result through parse', () => {
    const parsed = MutationResult.parse({ kind: 'applied', result: { issue: { id: 'i1' } } })
    expect(parsed).toEqual({ kind: 'applied', result: { issue: { id: 'i1' } } })
  })
})
