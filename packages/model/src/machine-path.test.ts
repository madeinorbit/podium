import { describe, expect, it } from 'vitest'
import { isAbsoluteMachinePath } from './machine-path'

describe('isAbsoluteMachinePath', () => {
  it('accepts POSIX and Windows absolute paths', () => {
    for (const path of [
      '/home/me/repo',
      'C:\\src\\podium',
      'c:/src/podium',
      '\\\\nas\\share\\repo',
    ])
      expect(isAbsoluteMachinePath(path), path).toBe(true)
  })
  it('refuses relative and drive-relative paths', () => {
    for (const path of ['repo', './repo', 'C:repo', '\\repo', '', '~/repo'])
      expect(isAbsoluteMachinePath(path), path).toBe(false)
  })
})
