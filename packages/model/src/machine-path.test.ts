import { describe, expect, it } from 'vitest'
import {
  isAbsoluteMachinePath,
  isMachinePathWithinRoot,
  joinMachinePath,
  machinePathBasename,
  machinePathDirname,
  machinePathHasSuffix,
  machinePathRelativeToRoot,
  machinePathSegments,
  machinePathSeparator,
  normalizeMachinePath,
  resolveMachinePath,
} from './machine-path'

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

describe('machine paths independent of the client OS', () => {
  it.each([
    ['/repo/', './src/../x.ts', '/repo/x.ts'],
    ['/repo', '/tmp/../a.ts', '/a.ts'],
    ['/', '../../x.ts', '/x.ts'],
    ['/repo', 'a\\b.ts', '/repo/a\\b.ts'],
    ['C:\\src\\podium', 'apps\\web/../x.ts', 'C:\\src\\podium\\apps\\x.ts'],
    ['c:/src/podium/', '../x.ts', 'c:\\src\\x.ts'],
    ['C:\\src', 'D:/other/../x.ts', 'D:\\x.ts'],
    ['C:\\src', '/x.ts', 'C:\\x.ts'],
    ['C:\\src', '\\x.ts', 'C:\\x.ts'],
    ['C:\\', '../../x.ts', 'C:\\x.ts'],
    ['\\\\nas\\share\\repo', '..\\..\\..\\x.ts', '\\\\nas\\share\\x.ts'],
    ['//nas/share/repo', 'src/x.ts', '/nas/share/repo/src/x.ts'],
    ['/repo', 'C:\\src\\x.ts', 'C:\\src\\x.ts'],
  ])('resolves %s + %s', (root, child, expected) => {
    expect(resolveMachinePath(root, child)).toBe(expected)
  })

  it.each([
    ['/repo', 'src/x.ts', '/', '/repo/src/x.ts', 'x.ts', '/repo/src', 'src/x.ts'],
    ['C:/repo/', 'src\\x.ts', '\\', 'C:\\repo\\src\\x.ts', 'x.ts', 'C:\\repo\\src', 'src\\x.ts'],
    [
      '\\\\nas\\share',
      'src/x.ts',
      '\\',
      '\\\\nas\\share\\src\\x.ts',
      'x.ts',
      '\\\\nas\\share\\src',
      'src\\x.ts',
    ],
  ])('joins and displays %s', (root, child, separator, full, name, dir, relative) => {
    expect(machinePathSeparator(root)).toBe(separator)
    expect(joinMachinePath(root, child)).toBe(full)
    expect(machinePathBasename(full)).toBe(name)
    expect(machinePathDirname(full)).toBe(dir)
    expect(machinePathRelativeToRoot(root, full)).toBe(relative)
    expect(machinePathRelativeToRoot(root, child)).toBe(relative)
    expect(isMachinePathWithinRoot(root, full)).toBe(true)
  })

  it('compares whole segments and Windows casing, without folding POSIX casing', () => {
    expect(machinePathRelativeToRoot('C:\\repo', 'c:/REPO/src/x.ts')).toBe('src\\x.ts')
    expect(machinePathRelativeToRoot('/repo', '/REPO/x.ts')).toBeNull()
    expect(machinePathRelativeToRoot('C:\\repo', 'C:\\repository\\x.ts')).toBeNull()
    expect(machinePathRelativeToRoot('C:\\repo', 'D:\\repo\\x.ts')).toBeNull()
    expect(machinePathRelativeToRoot('\\\\nas\\share', '\\\\nas\\other\\x.ts')).toBeNull()
    expect(machinePathRelativeToRoot('/repo', '../x.ts')).toBeNull()
    expect(machinePathRelativeToRoot('/', '/x.ts')).toBe('x.ts')
    expect(machinePathRelativeToRoot('C:\\', 'C:\\x.ts')).toBe('x.ts')
    expect(machinePathRelativeToRoot('C:\\repo', 'c:/repo/')).toBe('')
  })

  it('preserves roots and relative parents', () => {
    for (const root of ['/', 'C:\\', '\\\\nas\\share\\']) {
      expect(normalizeMachinePath(root)).toBe(root)
      expect(machinePathDirname(root)).toBe(root)
    }
    expect(normalizeMachinePath('../src/../../x.ts')).toBe('../../x.ts')
    expect(normalizeMachinePath('src\\..\\x.ts', 'C:\\repo')).toBe('x.ts')
    expect(machinePathBasename('/repo/')).toBe('repo')
    expect(machinePathBasename('C:\\repo\\')).toBe('repo')
    expect(machinePathDirname('x.ts')).toBe('.')
    expect(machinePathSegments('C:\\src/mixed\\x.ts')).toEqual(['C:', 'src', 'mixed', 'x.ts'])
    expect(machinePathSegments('a\\b/c', '/repo')).toEqual(['a\\b', 'c'])
  })
})

describe('machinePathHasSuffix', () => {
  it('matches Windows spelling variants at segment boundaries', () => {
    expect(machinePathHasSuffix('C:\\repo\\shots\\final.png', 'shots/final.png')).toBe(true)
    expect(machinePathHasSuffix('C:\\repo\\shots\\final.png', 'c:/REPO/shots/final.png')).toBe(true)
    expect(machinePathHasSuffix('C:\\repo\\shots-final.png', 'final.png')).toBe(false)
    expect(machinePathHasSuffix('/repo/shots-final.png', 'final.png')).toBe(false)
    expect(machinePathHasSuffix('/repo/final.png', 'FINAL.png')).toBe(false)
  })
})

it('infers Windows only from an explicit root and keeps POSIX backslashes literal', () => {
  expect(machinePathSeparator('//srv/data/x')).toBe('/')
  expect(normalizeMachinePath('//srv/data/x')).toBe('/srv/data/x')
  expect(resolveMachinePath('/repo', '//srv/data/x')).toBe('/srv/data/x')
  expect(machinePathSeparator('foo\\bar.txt')).toBe('/')
  expect(machinePathBasename('foo\\bar.txt')).toBe('foo\\bar.txt')
  expect(machinePathDirname('foo\\bar.txt')).toBe('.')
  expect(normalizeMachinePath('src\\..\\x.ts')).toBe('src\\..\\x.ts')
  expect(machinePathSegments('foo\\bar.txt')).toEqual(['foo\\bar.txt'])
  expect(machinePathBasename('src\\x.ts', 'C:\\repo')).toBe('x.ts')
  expect(machinePathDirname('src\\x.ts', 'C:\\repo')).toBe('src')
  expect(machinePathSeparator('C:relative')).toBe('/')
})
