import { describe, expect, it } from 'vitest'
import { classifyLibsqlFailure } from './libsql-driver'

describe('classifyLibsqlFailure', () => {
  it('classifies a transitively wrapped SQLITE_BUSY error as retryable', () => {
    const original = Object.assign(new Error('opaque driver failure'), {
      code: 'SQLITE_BUSY',
    })
    const wrapped = new Error('outer query wrapper', {
      cause: new Error('inner query wrapper', { cause: original }),
    })

    expect(classifyLibsqlFailure(wrapped)).toBe('busy')
  })
})
