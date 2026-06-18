import { describe, expect, it } from 'vitest'
import { knownPathsFor } from './file-relay-policy'

describe('knownPathsFor', () => {
  it('collects toolPaths from transcript items into a set', () => {
    const set = knownPathsFor([
      { id: '1', role: 'tool', text: '', toolPaths: ['/repo/a.ts', '/home/u/memo.md'] },
      { id: '2', role: 'assistant', text: 'hi' },
      { id: '3', role: 'tool', text: '', toolPaths: ['/repo/a.ts'] },
    ])
    expect(set.has('/repo/a.ts')).toBe(true)
    expect(set.has('/home/u/memo.md')).toBe(true)
    expect(set.size).toBe(2)
  })
})
