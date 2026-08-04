/**
 * The indexed lookup must be the linear scan, exactly (POD-1645).
 *
 * `worktreeForCwdIndexed` exists only to make `worktreeForCwd` cheap: a
 * disagreement between them is not a performance regression, it is a session
 * attributed to the WRONG issue, which is worse than the freeze the index was
 * built to remove. So the scan is kept as the oracle and the index is graded
 * against it — on a table of the cases that actually distinguish them, and on
 * randomised corpora that no table would think to write down.
 */
import { describe, expect, it } from 'vitest'
import {
  buildWorktreeRootIndex,
  worktreeForCwd,
  worktreeForCwdIndexed,
  worktreeSubpath,
} from './worktree'

/** The two implementations, asked the same question. */
function both(cwd: string, roots: string[]): { scan: string | null; indexed: string | null } {
  return {
    scan: worktreeForCwd(cwd, roots),
    indexed: worktreeForCwdIndexed(cwd, buildWorktreeRootIndex(roots)),
  }
}

function expectAgreement(cwd: string, roots: string[]): string | null {
  const { scan, indexed } = both(cwd, roots)
  expect({ cwd, indexed }).toEqual({ cwd, indexed: scan })
  return scan
}

describe('worktreeForCwdIndexed', () => {
  const cases: Array<{ name: string; cwd: string; roots: string[]; expected: string | null }> = [
    { name: 'exact root', cwd: '/r/a', roots: ['/r/a'], expected: '/r/a' },
    { name: 'nested under a root', cwd: '/r/a/apps/web', roots: ['/r/a'], expected: '/r/a' },
    {
      name: 'longest match wins — a repo contains its own .worktrees checkouts',
      cwd: '/r/a/.worktrees/x/apps/web',
      roots: ['/r/a', '/r/a/.worktrees/x'],
      expected: '/r/a/.worktrees/x',
    },
    {
      name: 'root order does not decide it',
      cwd: '/r/a/.worktrees/x/src',
      roots: ['/r/a/.worktrees/x', '/r/a'],
      expected: '/r/a/.worktrees/x',
    },
    { name: 'no containing root', cwd: '/elsewhere/z', roots: ['/r/a', '/r/b'], expected: null },
    {
      name: 'a sibling that merely shares a name PREFIX is not a container',
      cwd: '/r/abc/src',
      roots: ['/r/ab'],
      expected: null,
    },
    { name: 'trailing-slash root', cwd: '/r/a/src', roots: ['/r/a/'], expected: '/r/a/' },
    {
      name: 'both spellings of one root — the scan kept the longer string',
      cwd: '/r/a/src',
      roots: ['/r/a', '/r/a/'],
      expected: '/r/a/',
    },
    { name: 'trailing-slash cwd at its own root', cwd: '/r/a/', roots: ['/r/a'], expected: '/r/a' },
    { name: 'the filesystem root as a root', cwd: '/x/y', roots: ['/'], expected: '/' },
    { name: 'empty root list', cwd: '/r/a', roots: [], expected: null },
    { name: 'relative paths', cwd: 'r/a/src', roots: ['r/a'], expected: 'r/a' },
  ]

  for (const { name, cwd, roots, expected } of cases) {
    it(`${name}`, () => {
      expect(expectAgreement(cwd, roots)).toBe(expected)
    })
  }

  it('agrees with the scan across randomised corpora', () => {
    // A deterministic PRNG: a flake here would be a real disagreement nobody
    // could reproduce, which is the worst possible way to learn about one.
    let seed = 0x1645
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    // No empty segment: `//` is out of buildWorktreeRootIndex's contract and
    // out of any real cwd. See its doc comment.
    const segments = ['r', 'a', 'ab', 'abc', '.worktrees', 'x', 'src', 'apps', 'web']
    const path = (): string => {
      const depth = 1 + rnd(5)
      let p = rnd(2) === 0 ? '' : '/'
      for (let i = 0; i < depth; i++) p += `${segments[rnd(segments.length)]}/`
      return rnd(3) === 0 ? p : p.slice(0, -1)
    }
    for (let trial = 0; trial < 400; trial++) {
      const roots = Array.from({ length: 1 + rnd(12) }, path)
      for (let probe = 0; probe < 6; probe++) expectAgreement(path(), roots)
      // …and every root is also a cwd worth asking about (exact-match case).
      for (const root of roots) expectAgreement(root, roots)
    }
  })

  it('is a lookup, not a scan: cost does not grow with the root count', () => {
    // The DEFECT was the count of string comparisons per resolution, so that is
    // what this asserts — not a duration, which on a loaded box is noise.
    // `buildWorktreeRootIndex` touches each root once; each lookup then touches
    // at most one map entry per path segment, whatever the root count is.
    const probeRoots = (n: number): number => {
      const roots = Array.from({ length: n }, (_, i) => `/r/w${i}`)
      const index = buildWorktreeRootIndex(roots)
      let gets = 0
      const counting = {
        get: (key: string) => {
          gets++
          return index.get(key)
        },
      } as unknown as typeof index
      expect(worktreeForCwdIndexed('/r/w7/apps/web/src', counting)).toBe('/r/w7')
      return gets
    }
    expect(probeRoots(10_000)).toBe(probeRoots(10))
  })
})

describe('worktreeSubpath', () => {
  it('reads the position inside the containing root', () => {
    expect(worktreeSubpath('/r/a', '/r/a/apps/web')).toBe('apps/web')
    expect(worktreeSubpath('/r/a', '/r/a')).toBe('')
    expect(worktreeSubpath('/r/a/', '/r/a/apps')).toBe('apps')
  })
})
