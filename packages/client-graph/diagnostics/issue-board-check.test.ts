import { expect, it } from 'vitest'
import { compareBoardValues } from './issue-board-check'
it('detects a planted row value and reports only its field position', () => {
  const expected = { rows: [{ title: 'Private example', count: 2 }] }
  expect(compareBoardValues(expected, expected)).toEqual({ differences: 0, first: null, pending: 0 })
  const result = compareBoardValues(expected, { rows: [{ title: 'Changed example', count: 2 }] })
  expect(result).toEqual({ differences: 1, first: 'rows.0.title', pending: 0 })
  expect(JSON.stringify(result)).not.toMatch(/Private|Changed/)
})
