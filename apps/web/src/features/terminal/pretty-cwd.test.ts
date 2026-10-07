import { describe, expect, it } from 'vitest'
import { prettyCwd } from './pretty-cwd'

describe('prettyCwd', () => {
  it.each([
    ['/home/me/repo', '~/repo'],
    ['/Users/me/repo', '~/repo'],
    ['/src/repo', '/src/repo'],
    ['C:\\Users\\me\\repo', '~\\repo'],
    ['C:/src/repo', 'C:\\src\\repo'],
    ['\\\\nas\\share\\repo', '\\\\nas\\share\\repo'],
  ])('displays %s natively', (path, expected) => {
    expect(prettyCwd(path)).toBe(expected)
  })
})
