import { describe, expect, it } from 'vitest'
import {
  isAbsoluteMachinePath,
  isMachinePathForOs,
  isMachinePathWithinRoot,
  isValidMachinePath,
  joinMachinePath,
  machinePathAncestors,
  machinePathBasename,
  machinePathDirname,
  machinePathHasDotSegment,
  machinePathHasSuffix,
  machinePathKey,
  machinePathRelativeToRoot,
  machinePathSegments,
  machinePathSeparator,
  machinePathsEqual,
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
    ['/repo', 'C:\\src\\x.ts', '/repo/C:\\src\\x.ts'],
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

describe('machine path identity', () => {
  it.each([
    ['C:\\src\\Podium\\', 'c:/src/podium'],
    ['C:\\src\\other\\..\\podium', 'c:/src/podium'],
    ['\\\\NAS\\Share\\Repo', '\\\\nas\\share/repo'],
  ])('uses the same Windows key for %s and %s', (a, b) => {
    expect(machinePathKey(a)).toBe(machinePathKey(b))
    expect(machinePathsEqual(a, b)).toBe(true)
  })
  it('keeps POSIX identities literal', () => {
    for (const path of ['/src/Podium', '/src/podium/', '/src/a\\b'])
      expect(machinePathKey(path)).toBe(path)
    expect(machinePathsEqual('/src/Podium', '/src/podium')).toBe(false)
  })
})

describe('machine paths: review namespace and segment guards', () => {
  it.each([
    '.. ',
    '...',
    '.. .',
    'name.',
    'name ',
  ])('rejects ambiguous Windows segment %s before normalization', (segment) => {
    const root = String.raw`C:\repo`
    const path = root + '\\' + segment
    expect(isValidMachinePath(path)).toBe(false)
    expect(normalizeMachinePath(path)).toBe(path)
    expect(machinePathBasename(path)).toBe(segment)
    expect(machinePathKey(path)).toBe(path.replace('C:', 'c:'))
    expect(machinePathHasSuffix(path, segment)).toBe(false)
    expect(machinePathAncestors(path)).toEqual([])
    expect(isMachinePathWithinRoot(root, path)).toBe(false)
    expect(machinePathRelativeToRoot(root, path)).toBeNull()
    expect(isMachinePathWithinRoot(path, path)).toBe(false)
    expect(isValidMachinePath('/repo/' + segment)).toBe(true)
    expect(normalizeMachinePath('/repo/' + segment)).toBe('/repo/' + segment)
  })
  it.each([
    'C:/shot.png',
    String.raw`\a\b.png`,
    String.raw`\\a\b.png`,
  ])('interprets %s within a POSIX root as a relative name', (path) => {
    expect(isAbsoluteMachinePath(path, '/wt')).toBe(false)
    expect(resolveMachinePath('/wt', path)).toBe('/wt/' + path)
    expect(machinePathRelativeToRoot('/wt', path)).toBe(path)
    expect(isMachinePathWithinRoot('/wt', '/wt/' + path)).toBe(true)
  })
  it('still resolves ordinary Windows dot segments and absolute drive paths', () => {
    expect(resolveMachinePath(String.raw`C:\repo`, '../shot.png')).toBe(String.raw`C:\shot.png`)
    expect(resolveMachinePath(String.raw`C:\repo`, 'D:/shot.png')).toBe(String.raw`D:\shot.png`)
    expect(isValidMachinePath(String.raw`\\server.\share\file`)).toBe(false)
  })
})

it.each([
  ['/repo/src', ['/repo/src', '/repo', '/']],
  [String.raw`C:\Repo\src`, [String.raw`C:\Repo\src`, String.raw`C:\Repo`, 'C:\\']],
  [String.raw`\\nas\share\repo`, [String.raw`\\nas\share\repo`, '\\\\nas\\share\\']],
])('machine paths: ancestor roots for %s', (path, ancestors) => {
  expect(machinePathAncestors(path)).toEqual(ancestors)
})

describe('machine paths: conservative Windows case comparisons', () => {
  it('slices original segments even when Unicode lowercase would change their length', () => {
    expect(machinePathRelativeToRoot(String.raw`C:\İ`, String.raw`C:\İ\abc`)).toBe('abc')
    expect(machinePathRelativeToRoot(String.raw`C:\İ`, String.raw`c:\İ\ABC`)).toBe('ABC')
    expect(machinePathRelativeToRoot(String.raw`C:\İ`, String.raw`C:\i\abc`)).toBeNull()
  })
  it('never aliases the Kelvin sign to ASCII k in authorization, identity or suffixes', () => {
    const root = String.raw`C:\work`
    const other = String.raw`C:\worK\secret`
    expect(isMachinePathWithinRoot(root, other)).toBe(false)
    expect(machinePathRelativeToRoot(root, other)).toBeNull()
    expect(machinePathsEqual(root, String.raw`c:\worK`)).toBe(false)
    expect(machinePathHasSuffix(String.raw`C:\worK\secret`, 'work/secret')).toBe(false)
    expect(machinePathKey(String.raw`C:\İ\WORK`)).toBe(String.raw`c:\İ\work`)
    expect(machinePathRelativeToRoot(root, String.raw`c:\WORK\Secret`)).toBe('Secret')
    expect(machinePathRelativeToRoot('/İ', '/İ/abc')).toBe('abc')
    expect(isMachinePathWithinRoot('/work', '/worK/secret')).toBe(false)
  })
  it('retains invalid segments even when a following parent would erase them', () => {
    const invalid = String.raw`C:\repo\...\..\src\a.ts`
    expect(normalizeMachinePath(invalid)).toBe(invalid)
    expect(isMachinePathWithinRoot(String.raw`C:\repo`, normalizeMachinePath(invalid))).toBe(false)
  })
  it('keeps literal POSIX basenames and has no basename for a filesystem root', () => {
    expect(machinePathBasename('/')).toBe('')
    expect(machinePathBasename('///')).toBe('')
    expect(machinePathBasename('/a/b/..')).toBe('..')
    expect(machinePathBasename('/a/.')).toBe('.')
  })
})

// A cwd is an absolute machine path, not a root-relative file token.
it('does not place an absolute POSIX cwd under a Windows checkout', () => {
  expect(isMachinePathWithinRoot(String.raw`C:\src\podium`, '/src/podium/src/app')).toBe(false)
})

// POD-7311 review F1: a literal POSIX prefix test counted `/repo/../.ssh` as inside `/repo`.
describe('machine path containment refuses dot segments', () => {
  it.each([
    [
      'POSIX',
      '/home/alice/repo',
      [
        '/home/alice/repo/../.ssh/id_ed25519',
        '/home/alice/repo/..',
        '/home/alice/repo/./src',
        '/home/alice/repo/src/../../x',
        '/home/alice/repo/.',
      ],
    ],
    [
      'POSIX root with a trailing slash',
      '/home/alice/repo/',
      ['/home/alice/repo/../.ssh', '/home/alice/repo//..//x'],
    ],
    [
      'Windows',
      String.raw`C:\Users\alice\repo`,
      [
        String.raw`C:\Users\alice\repo\..\.ssh\id_ed25519`,
        'c:/Users/alice/repo/../secret',
        String.raw`C:\Users\alice\repo\.\src`,
        String.raw`C:\Users\alice\repo\src\..\x`,
        String.raw`C:\Users\alice\repo/./x`,
      ],
    ],
    [
      'UNC',
      String.raw`\\nas\share\repo`,
      [
        String.raw`\\nas\share\repo\..\other`,
        '//nas/share/repo/../other'.replace(/\//g, '\\'),
        String.raw`\\nas\share\repo\.\x`,
        String.raw`\\nas\share\repo\x\..\..\..\y`,
      ],
    ],
  ])('%s: refuses a path under %s that has a dot segment', (_name, root, paths) => {
    for (const path of paths) {
      expect(machinePathHasDotSegment(path, root)).toBe(true)
      expect(isMachinePathWithinRoot(root, path)).toBe(false)
      expect(machinePathRelativeToRoot(root, path)).toBeNull()
      expect(machinePathAncestors(path)).toEqual([])
    }
  })

  it.each([
    ['/home/alice/repo/..', '/home/alice/repo/../x'],
    ['/home/alice/./repo', '/home/alice/./repo/x'],
    [String.raw`C:\Users\alice\repo\..`, String.raw`C:\Users\alice\repo\..\x`],
    [String.raw`\\nas\share\repo\.`, String.raw`\\nas\share\repo\.\x`],
  ])('refuses a root with a dot segment: %s', (root, path) => {
    expect(isMachinePathWithinRoot(root, path)).toBe(false)
    expect(isMachinePathWithinRoot(root, root)).toBe(false)
    expect(machinePathRelativeToRoot(root, path)).toBeNull()
  })

  it.each([
    ['/home/alice/repo', '/home/alice/repo/src/x.ts', 'src/x.ts'],
    ['/home/alice/repo', '/home/alice/repo/.config/..rc/...', '.config/..rc/...'],
    [String.raw`C:\Users\alice\repo`, 'c:/users/ALICE/repo/.git/x', String.raw`.git\x`],
    [String.raw`\\nas\share\repo`, String.raw`\\NAS\share\repo\.hidden`, '.hidden'],
  ])('still admits names that only start with a dot under %s', (root, path, relative) => {
    expect(machinePathHasDotSegment(path, root)).toBe(false)
    expect(isMachinePathWithinRoot(root, path)).toBe(true)
    expect(machinePathRelativeToRoot(root, path)).toBe(relative)
  })

  it('keeps POSIX backslashes literal: `a\\..\\b` is one name, not a parent', () => {
    expect(machinePathHasDotSegment(String.raw`/repo/a\..\b`)).toBe(false)
    expect(isMachinePathWithinRoot('/repo', String.raw`/repo/a\..\b`)).toBe(true)
    expect(machinePathHasDotSegment(String.raw`a\..\b`, String.raw`C:\repo`)).toBe(true)
  })

  it('admits a relative `./` token but never one that climbs, even back inside', () => {
    expect(machinePathRelativeToRoot('/repo', './shot.png')).toBe('shot.png')
    expect(machinePathRelativeToRoot(String.raw`C:\repo`, String.raw`.\shots\a.png`)).toBe(
      String.raw`shots\a.png`,
    )
    expect(machinePathRelativeToRoot('/repo', '../repo/x.ts')).toBeNull()
    expect(machinePathRelativeToRoot('/repo', 'src/../x.ts')).toBeNull()
    expect(machinePathRelativeToRoot(String.raw`C:\repo`, String.raw`src\..\x.ts`)).toBeNull()
    // A caller that holds a token resolves it first, then asks.
    expect(machinePathRelativeToRoot('/repo', resolveMachinePath('/repo', 'src/../x.ts'))).toBe(
      'x.ts',
    )
  })

  it('agrees between the literal membership test and the ancestor index', () => {
    for (const path of [
      '/repo/../etc',
      '/repo/./src',
      String.raw`C:\repo\..\etc`,
      String.raw`\\nas\share\..\x`,
    ]) {
      const ancestors = machinePathAncestors(path)
      expect(ancestors.some((root) => isMachinePathWithinRoot(root, path))).toBe(false)
      expect(
        isMachinePathWithinRoot('/repo', path) ||
          isMachinePathWithinRoot(String.raw`C:\repo`, path),
      ).toBe(false)
    }
  })
})

// POD-7501 F3: Win32 may read `..::$INDEX_ALLOCATION` as the parent folder.
describe('machine path containment refuses dot segments with an NTFS stream suffix', () => {
  it.each([
    [String.raw`C:\repo`, String.raw`C:\repo\..::$INDEX_ALLOCATION\secret`],
    [String.raw`C:\repo`, String.raw`C:\repo\.::$DATA`],
    [String.raw`C:\repo`, 'c:/repo/..:$I30:$INDEX_ALLOCATION/x'],
    [String.raw`\\nas\share\repo`, String.raw`\\nas\share\repo\..::$INDEX_ALLOCATION\x`],
  ])('under %s refuses %s', (root, path) => {
    expect(machinePathHasDotSegment(path, root)).toBe(true)
    expect(isMachinePathWithinRoot(root, path)).toBe(false)
    expect(machinePathRelativeToRoot(root, path)).toBeNull()
    expect(machinePathAncestors(path)).toEqual([])
  })

  it('refuses a stream-suffixed dot root and relative token', () => {
    const root = String.raw`C:\repo\..::$INDEX_ALLOCATION`
    expect(isMachinePathWithinRoot(root, String.raw`${root}\x`)).toBe(false)
    expect(
      machinePathRelativeToRoot(String.raw`C:\repo`, String.raw`..::$INDEX_ALLOCATION\x`),
    ).toBeNull()
    expect(machinePathRelativeToRoot(String.raw`C:\repo`, String.raw`.::$DATA\x`)).toBeNull()
  })

  it('still admits a stream on an ordinary name, and POSIX names with colons', () => {
    expect(isMachinePathWithinRoot(String.raw`C:\repo`, String.raw`C:\repo\a.txt::$DATA`)).toBe(
      true,
    )
    expect(isMachinePathWithinRoot(String.raw`C:\repo`, String.raw`C:\repo\...::x`)).toBe(true)
    expect(machinePathHasDotSegment('/repo/..:x/.:y')).toBe(false)
    expect(isMachinePathWithinRoot('/repo', '/repo/..:x')).toBe(true)
  })
})

// POD-7501 F4: `''` plus `/` is a prefix of every absolute POSIX path.
describe('machine path containment refuses an empty root', () => {
  it.each(['/etc', '/', 'relative', ''])('`` does not contain %s', (path) => {
    expect(isMachinePathWithinRoot('', path)).toBe(false)
    expect(machinePathRelativeToRoot('', path)).toBeNull()
  })
})

// POD-7501 F2: registration refuses a path spelled for another OS.
describe('isMachinePathForOs', () => {
  it.each([
    ['/home/a/repo', 'linux', true],
    ['/Users/a/repo', 'darwin', true],
    [String.raw`C:\Users\a\repo`, 'linux', false],
    [String.raw`\\nas\share\repo`, 'darwin', false],
    ['relative/repo', 'linux', false],
    [String.raw`C:\Users\a\repo`, 'win32', true],
    ['c:/Users/a/repo', 'win32', true],
    [String.raw`\\nas\share\repo`, 'win32', true],
    ['/c/Users/a/repo', 'win32', false],
    ['//nas/share/repo', 'win32', false],
    [String.raw`repo\x`, 'win32', false],
  ] as const)('%s on %s is %s', (path, os, expected) => {
    expect(isMachinePathForOs(path, os)).toBe(expected)
  })
})
