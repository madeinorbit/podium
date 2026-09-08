import { describe, expect, it } from 'vitest'
import { classifyLibsqlFailure, unwrapCause } from './libsql-driver'

describe('classifyLibsqlFailure', () => {
  it('classifies a transitively wrapped SQLITE_BUSY error as retryable', () => {
    const original = Object.assign(new Error('opaque driver failure'), {
      code: 'SQLITE_BUSY',
    })
    const wrapped = new Error('Failed query: insert into w ...', {
      cause: new Error('inner query wrapper', { cause: original }),
    })

    expect(classifyLibsqlFailure(wrapped)).toBe('busy')
    expect(classifyLibsqlFailure(original)).toBe('busy')
  })

  it('classifies the idle-reaper message as busy even without a code', () => {
    expect(
      classifyLibsqlFailure(
        new Error(
          'SQLITE_BUSY: interactive transaction was rolled back because the stream was idle for too long; retry the transaction',
        ),
      ),
    ).toBe('busy')
  })

  it('classifies TRANSACTION_CLOSED as fatal', () => {
    const closed = Object.assign(new Error('Cannot execute statements because the transaction is closed'), {
      code: 'TRANSACTION_CLOSED',
    })
    expect(classifyLibsqlFailure(closed)).toBe('fatal')
    expect(classifyLibsqlFailure(new Error('Failed query', { cause: closed }))).toBe('fatal')
  })

  it('does not treat a DrizzleQueryError UNIQUE failure as busy', () => {
    const original = Object.assign(new Error('UNIQUE constraint failed: w.scope, w.name'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    })
    const wrapped = new Error('Failed query: insert into w ...', { cause: original })
    expect(classifyLibsqlFailure(wrapped)).toBe('fatal')
  })
})

describe('unwrapCause', () => {
  it('returns the innermost cause, not the drizzle wrapper', () => {
    const original = Object.assign(new Error('UNIQUE constraint failed: w.scope, w.name'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    })
    const wrapped = new Error('Failed query: insert into w ...', {
      cause: new Error('inner', { cause: original }),
    })
    expect(unwrapCause(wrapped)).toBe(original)
  })
})
