import { describe, expect, it } from 'vitest'
import type { Cell } from './buffer-line'
import { findStyledPathMatches, makeFileLinkProvider } from './file-link-provider'

function cells(s: string, styled: boolean, y = 0): Cell[] {
  return [...s].map((char, x) => ({ char, x, y, styled }))
}

describe('findStyledPathMatches', () => {
  const cfg = {
    cwd: '/repo',
    knownPaths: new Set(['/repo/apps/web/src/derive.ts']),
    onOpen: () => {},
  }

  it('matches a styled path-like run', () => {
    const m = findStyledPathMatches(cells('edit apps/web/src/derive.ts', true), cfg)
    expect(m).toHaveLength(1)
    expect(m[0]!.path).toBe('/repo/apps/web/src/derive.ts')
  })

  it('ignores an unstyled run even if path-like', () => {
    expect(findStyledPathMatches(cells('apps/web/src/derive.ts', false), cfg)).toHaveLength(0)
  })

  it('does NOT link a branch ref like feat/studio (cwd-relative, no file extension)', () => {
    expect(findStyledPathMatches(cells('feat/studio', true), cfg)).toHaveLength(0)
    expect(findStyledPathMatches(cells('release/v2', true), cfg)).toHaveLength(0)
  })

  it('still links a cwd-relative path that HAS a file extension', () => {
    const m = findStyledPathMatches(cells('src/new/thing.ts', true), cfg)
    expect(m).toHaveLength(1)
    expect(m[0]!.path).toBe('/repo/src/new/thing.ts')
  })

  it('resolves a truncated styled token to the full known path (suffix match)', () => {
    const line = [...cells('see ', false), ...cells('derive.ts', true), ...cells(' here', false)]
    const m = findStyledPathMatches(line, cfg)
    expect(m).toHaveLength(1)
    expect(m[0]!.path).toBe('/repo/apps/web/src/derive.ts')
  })

  it('keeps the real coords of the matched cells for wrapped runs', () => {
    const run = [...cells('/repo/a', true, 0), ...cells('bc.ts', true, 1)]
    const m = findStyledPathMatches(run, cfg)
    expect(m[0]!.cells[0]).toMatchObject({ y: 0 })
    expect(m[0]!.cells.at(-1)!).toMatchObject({ y: 1 })
  })
})

describe('Windows terminal file links', () => {
  const cfg = {
    cwd: 'C:\\src\\podium',
    knownPaths: new Set(['C:\\src\\podium\\apps\\web\\x.ts', '\\\\nas\\share\\x.ts']),
    onOpen: () => {},
  }

  it.each([
    ['C:\\src\\podium\\apps\\web\\x.ts:12:3', 'C:\\src\\podium\\apps\\web\\x.ts'],
    ['c:/src/podium/apps/web/x.ts:12', 'C:\\src\\podium\\apps\\web\\x.ts'],
    ['src\\x.ts', 'C:\\src\\podium\\src\\x.ts'],
    ['src\\..\\x.ts', 'C:\\src\\podium\\x.ts'],
    ['apps/web\\x.ts', 'C:\\src\\podium\\apps\\web\\x.ts'],
    ['web\\x.ts', 'C:\\src\\podium\\apps\\web\\x.ts'],
    ['\\\\nas\\share\\x.ts:12:3', '\\\\nas\\share\\x.ts'],
  ])('detects %s and opens %s', (token, path) => {
    const matches = findStyledPathMatches(cells(token, true), cfg)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.path).toBe(path)
    expect(matches[0]?.cells.map((cell) => cell.char).join('')).toBe(token)
  })

  it('keeps branch refs, URLs, escaping paths and prefix siblings unlinked', () => {
    for (const token of [
      'feat\\studio',
      'https://example.test/x.ts',
      '..\\outside.ts',
      'C:\\src\\podium-other\\x.ts',
    ])
      expect(findStyledPathMatches(cells(token, true), cfg)).toEqual([])
  })
})

it('dispatches the Windows path without line/column through the xterm link activation', () => {
  const text = 'C:\\repo\\x.ts:12:3'
  let opened: string | undefined
  const provider = makeFileLinkProvider(
    () => ({
      getLine: (y) =>
        y !== 0
          ? undefined
          : {
              length: text.length,
              isWrapped: false,
              getCell: (x) => ({
                getChars: () => text[x]!,
                getWidth: () => 1,
                isBold: () => true,
                isUnderline: () => false,
                getFgColor: () => 0,
                getFgColorMode: () => 0,
              }),
            },
    }),
    () => ({
      cwd: 'C:\\repo',
      knownPaths: new Set(),
      onOpen: (path) => {
        opened = path
      },
    }),
  )
  provider.provideLinks(1, (links) => {
    expect(links).toHaveLength(1)
    expect(links?.[0]?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: text.length, y: 1 } })
    links?.[0]?.activate({} as MouseEvent, text)
  })
  expect(opened).toBe('C:\\repo\\x.ts')
})

it.each([
  'error:src/a.ts',
  'src/a.ts:12-15',
  'src/a.ts:12:3',
])('preserves POSIX file links in styled %s', (text) => {
  const cfg = { cwd: '/home/u/repo', knownPaths: new Set<string>(), onOpen: () => {} }
  const matches = findStyledPathMatches(cells(text, true), cfg)
  expect(matches).toHaveLength(1)
  expect(matches[0]?.path).toBe('/home/u/repo/src/a.ts')
})

it.each([
  'see:https://x/a.js',
  'https://x/a.js',
  'error:https://x/a.js',
])('does not reinterpret a labeled URL %s as a file', (text) => {
  const cfg = { cwd: '/home/u/repo', knownPaths: new Set<string>(), onOpen: () => {} }
  expect(findStyledPathMatches(cells(text, true), cfg)).toEqual([])
})

it('keeps known POSIX suffix paths literal, including duplicate separators', () => {
  const path = '/repo/apps//web/x.ts'
  const cfg = { cwd: '/repo', knownPaths: new Set([path]), onOpen: () => {} }
  expect(findStyledPathMatches(cells('x.ts', true), cfg)[0]?.path).toBe(path)
})
