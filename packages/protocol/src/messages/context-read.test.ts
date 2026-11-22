import { describe, expect, it } from 'vitest'
import {
  admitContextReadResult,
  CAP_CONTEXT_OBSERVATION_V1,
  CAP_CONTEXT_READ_V1,
  CONTEXT_READ_MAX_BYTES,
  type ContextReadRequest,
  type ContextReadResult,
  ContextReadRequest as Request,
  RuntimeContextReadRequestMessage,
  RuntimeContextReadResultMessage,
} from './runtime'

const sample = {
  id: 'invented-sample',
  at: '2026-11-21T12:00:00.000Z',
  bindingVersion: 1,
  observerGeneration: 1,
  turnEpoch: 0,
  contextRevision: 1,
}
const read: Extract<ContextReadRequest, { intent: 'breakdown' }> = {
  intent: 'breakdown',
  sample,
  timeoutMs: 1000,
  maxRows: 16,
}
const quantity = { value: 20, accuracy: 'reported', source: 'invented adapter' } as const
const answer: Extract<ContextReadResult, { intent: 'breakdown' }> = {
  intent: 'breakdown',
  result: { version: 1, status: 'available', sample, lastRequest: { input: quantity } },
}
const row = (n: number) => ({
  id: `row-${n}`,
  label: 'Invented category',
  category: 'invented',
  kind: 'used',
  attribution: 'category',
  tokens: quantity,
})
const composition = (rows: unknown[]) => ({
  ...answer,
  result: {
    ...answer.result,
    composition: {
      coverage: 'partial',
      rows,
      truncated: false,
    },
  },
})

describe('normalized context read wire and response admission', () => {
  it('negotiates detail transport independently and preserves explicit intent/sample', () => {
    expect(CAP_CONTEXT_READ_V1).not.toBe(CAP_CONTEXT_OBSERVATION_V1)
    expect(Request.parse(read)).toEqual(read)
    expect(
      RuntimeContextReadRequestMessage.parse({
        type: 'runtimeContextReadRequest',
        requestId: 'request-1',
        sessionId: 'session-1',
        read,
      }),
    ).toMatchObject({ read })
    expect(
      RuntimeContextReadResultMessage.parse({
        type: 'runtimeContextReadResult',
        requestId: 'request-1',
        sessionId: 'session-1',
        result: answer,
      }),
    ).toMatchObject({ result: answer })
    expect(admitContextReadResult(read, answer)).toEqual(answer)
  })
  it.each([
    'cancelled',
    'refused',
    'superseded',
    'unsupported',
    'unavailable',
  ] as const)('preserves a typed %s outcome and its causal identity', (status) => {
    const value = {
      intent: 'breakdown',
      result: { version: 1, status, sample, reason: { code: status, message: 'Invented outcome' } },
    }
    expect(admitContextReadResult(read, value)).toEqual(value)
  })
  it('rejects intent or sample mismatches without substituting another sample', () => {
    expect(
      admitContextReadResult(read, {
        ...answer,
        result: { ...answer.result, sample: { ...sample, id: 'other' } },
      }),
    ).toMatchObject({ result: { status: 'superseded', sample } })
    expect(admitContextReadResult({ intent: 'summary', timeoutMs: 1000 }, answer)).toMatchObject({
      intent: 'summary',
      result: { status: 'refused' },
    })
  })
  it('enforces per-request and total row budgets before rendering', () => {
    expect(
      admitContextReadResult({ ...read, maxRows: 1 }, composition([row(1), row(2)])),
    ).toMatchObject({ result: { status: 'refused' } })
    expect(
      admitContextReadResult(
        { ...read, maxRows: 128 },
        composition(Array.from({ length: 129 }, (_, n) => row(n))),
      ),
    ).toMatchObject({ result: { status: 'refused' } })
  })
  it('enforces four-level trees, bounded labels and normalized response bytes', () => {
    const deep = Array.from({ length: 5 }, (_, n) => ({
      ...row(n),
      ...(n > 0 ? { parentId: `row-${n - 1}` } : {}),
    }))
    expect(admitContextReadResult(read, composition(deep))).toMatchObject({
      result: { status: 'refused' },
    })
    expect(
      admitContextReadResult(read, composition([{ ...row(0), label: 'x'.repeat(257) }])),
    ).toMatchObject({ result: { status: 'refused' } })
    expect(
      admitContextReadResult(read, { ...answer, unexpected: 'x'.repeat(CONTEXT_READ_MAX_BYTES) }),
    ).toMatchObject({ result: { status: 'refused' } })
    // UTF-8 budget, not JavaScript string length; unknown data never reaches clients.
    expect(
      admitContextReadResult(read, {
        ...answer,
        unexpected: '界'.repeat(CONTEXT_READ_MAX_BYTES / 2),
      }),
    ).toMatchObject({ result: { status: 'refused' } })
  })
})
