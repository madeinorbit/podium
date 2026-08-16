import { describe, expect, it } from 'vitest'
import { isTerminalOperationState, parseOperation } from './operation'

/**
 * The conformance suite for the frozen operation contract (P8), the sibling of
 * `update/server-version.test.ts`. Its job is to fail when someone makes the
 * operation object less tolerant, because the failure it prevents is invisible
 * in development: an old web bundle rendering a newer server's operation *is*
 * the normal case during an update, and it happens in production only.
 */

/** A full payload, every field populated — the spec §3.1 example. */
const full = {
  id: 'op_01j',
  kind: 'update',
  state: 'running',
  exclusionGroup: 'lifecycle',
  details: { target: { version: '0.4.3', channel: 'dev' } },
  createdBy: 'user',
  createdAt: 1765700000000,
  startedAt: 1765700000000,
  updatedAt: 1765700041000,
  finishedAt: null,
  steps: [
    { id: 'prepare', title: 'Preparing the update', state: 'done' },
    {
      id: 'machines',
      title: 'Updating your machines',
      state: 'running',
      progress: { done: 1, total: 3 },
      lastProgressAt: 1765700041000,
      attempts: 1,
      places: [
        { id: 'm_a', name: 'vmi3407763', state: 'downloading', percent: 62 },
        { id: 'm_b', name: 'ludovico', state: 'done' },
      ],
    },
  ],
  awaiting: [{ id: 'desktop-install', surface: 'desktop', title: 'Restart Podium', required: true }],
  deferred: [{ id: 'm_c', name: 'macbook', reason: 'offline' }],
  error: null,
  retryOf: 'op_01i',
}

describe('parseOperation is a frozen contract', () => {
  it('ignores fields it has never heard of', () => {
    const op = parseOperation({ ...full, aFieldAddedNextYear: { nested: true } })
    expect(op?.state).toBe('running')
  })

  it('PRESERVES unknown fields, so a round-trip through the store cannot drop them', () => {
    const op = parseOperation({ ...full, aFieldAddedNextYear: { nested: true } })
    // The server re-persists what it parsed; a successor's field must survive.
    const round = parseOperation(JSON.parse(JSON.stringify(op)))
    expect((round as Record<string, unknown>).aFieldAddedNextYear).toEqual({ nested: true })
  })

  it('preserves unknown fields nested inside a step and inside a place', () => {
    const op = parseOperation({
      ...full,
      steps: [{ id: 'machines', state: 'running', eta: 42, places: [{ id: 'm_a', bytes: 17 }] }],
    })
    const step = op?.steps?.[0] as Record<string, unknown> | undefined
    expect(step?.eta).toBe(42)
    expect((step?.places as Record<string, unknown>[])[0].bytes).toBe(17)
  })

  for (const key of Object.keys(full)) {
    const required = key === 'id' || key === 'kind' || key === 'state'
    it(`${required ? 'refuses' : 'parses'} a payload with '${key}' absent`, () => {
      const partial = { ...full } as Record<string, unknown>
      delete partial[key]
      expect(parseOperation(partial) === null).toBe(required)
    })
  }

  it('parses the minimum an operation can be', () => {
    expect(parseOperation({ id: 'op_1', kind: 'test', state: 'pending' })?.id).toBe('op_1')
  })

  it('tolerates the two explicit nulls the spec shows on a live operation', () => {
    expect(parseOperation({ ...full, finishedAt: null, error: null })).not.toBeNull()
  })

  it('parses a kind it has never heard of, with details it cannot interpret', () => {
    const op = parseOperation({
      id: 'op_2',
      kind: 'server-move',
      state: 'running',
      details: { destination: { host: 'ludovico' } },
    })
    expect(op?.kind).toBe('server-move')
    expect((op?.details as Record<string, unknown>).destination).toEqual({ host: 'ludovico' })
  })

  it('carries a place state from a vocabulary the framework does not own', () => {
    const op = parseOperation({
      ...full,
      steps: [{ id: 's', state: 'running', places: [{ id: 'p', state: 'a-state-from-2027' }] }],
    })
    expect(op?.steps?.[0].places?.[0].state).toBe('a-state-from-2027')
  })
})

describe('parseOperation refuses what it cannot render', () => {
  it('refuses a payload that is not an object at all', () => {
    expect(parseOperation('op_1')).toBeNull()
    expect(parseOperation(null)).toBeNull()
    expect(parseOperation({})).toBeNull()
  })

  const retyped: [string, unknown][] = [
    ['id', 17],
    ['kind', { name: 'update' }],
    ['state', 'sideways'],
    ['state', 4],
    ['steps', 'prepare,machines'],
    ['awaiting', { id: 'ask' }],
    ['deferred', 'macbook'],
    ['updatedAt', '1765700041000'],
    ['error', 'it broke'],
  ]
  for (const [key, value] of retyped) {
    it(`refuses a payload whose '${key}' was retyped to ${JSON.stringify(value)}`, () => {
      expect(parseOperation({ ...full, [key]: value })).toBeNull()
    })
  }

  it('refuses a step state that is not one of the six', () => {
    expect(parseOperation({ ...full, steps: [{ id: 's', state: 'wedged' }] })).toBeNull()
  })

  it('refuses a step with no id', () => {
    expect(parseOperation({ ...full, steps: [{ state: 'running' }] })).toBeNull()
  })
})

describe('isTerminalOperationState', () => {
  it('is true for exactly the three outcomes', () => {
    expect(['done', 'failed', 'canceled'].every(isTerminalOperationState)).toBe(true)
  })

  it('is false for the three live states, and for a string it does not know', () => {
    expect(['pending', 'running', 'waiting', 'nonsense'].some(isTerminalOperationState)).toBe(false)
  })
})
