import { describe, expect, it } from 'vitest'
import { type AuthorityRefusal, normalizeRefusal } from './reasons'

describe('durable refusal explanations', () => {
  it.each([
    'invalid',
    'conflict',
    'confirmation-required',
  ] as const)('keeps a handler message for %s', (kind) => {
    expect(normalizeRefusal({ kind, message: 'Choose a machine first.' })).toEqual({
      code: kind,
      message: 'Choose a machine first.',
    })
  })

  it('keeps validation paths alongside the explanation', () => {
    expect(
      normalizeRefusal({
        kind: 'invalid',
        message: 'Name a machine.',
        details: ['input.machineId'],
      }),
    ).toEqual({ code: 'invalid', message: 'Name a machine.', details: ['input.machineId'] })
  })

  it.each([
    'unauthorized',
    'target-not-found',
  ] as const)('strips messages and details for %s so hidden and missing targets stay identical', (kind) => {
    expect(
      normalizeRefusal({
        kind,
        message: 'SECRET issue exists',
        details: ['SECRET'],
      } as unknown as AuthorityRefusal),
    ).toEqual({ code: 'unauthorized' })
  })

  it('omits empty explanations', () => {
    expect(normalizeRefusal({ kind: 'conflict', message: '  ' })).toEqual({ code: 'conflict' })
  })
})
