import { describe, expect, it } from 'vitest'
import { parseDiff, splitPath } from './diff-model'
import { untrackedDiff } from './git-panel'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,6 +10,7 @@ export function foo() {',
  '   const a = 1',
  '-  const b = 2',
  '+  const b = 3',
  '+  const c = 4',
  '   return a',
  '',
  ' }',
  '\\ No newline at end of file',
  '',
].join('\n')

describe('parseDiff', () => {
  it('drops the file preamble and keeps the hunk with its context', () => {
    const { rows } = parseDiff(DIFF)
    expect(rows[0]).toEqual({
      kind: 'hunk',
      text: '@@ -10,6 +10,7 @@',
      context: 'export function foo() {',
    })
    expect(rows.some((r) => r.text.startsWith('diff --git'))).toBe(false)
  })

  it('numbers both sides from the hunk header', () => {
    const { rows } = parseDiff(DIFF)
    // ctx 10/10 · del old 11 · add new 11 · add new 12 · ctx 12/13 · …
    expect(rows.slice(1, 6).map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['add', undefined, 12],
      ['ctx', 12, 13],
    ])
  })

  it('strips the marker column and keeps a git-trimmed empty context line', () => {
    const { rows } = parseDiff(DIFF)
    expect(rows[3]).toMatchObject({ kind: 'add', text: '  const b = 3' })
    // Git omits the leading space on an empty context line; it is still a line.
    expect(rows[6]).toMatchObject({ kind: 'ctx', text: '', oldNo: 13, newNo: 14 })
    expect(rows[7]).toMatchObject({ kind: 'ctx', text: '}' })
  })

  it('counts added and removed lines, and files the no-newline aside as a note', () => {
    const parsed = parseDiff(DIFF)
    expect({ added: parsed.added, removed: parsed.removed }).toEqual({ added: 2, removed: 1 })
    expect(parsed.rows.at(-1)).toEqual({ kind: 'note', text: 'No newline at end of file' })
  })

  it('flags a binary diff instead of pretending it has lines', () => {
    const parsed = parseDiff(
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    )
    expect(parsed.binary).toBe(true)
    expect(parsed.rows).toEqual([
      { kind: 'note', text: 'Binary files a/logo.png and b/logo.png differ' },
    ])
  })

  it('empty output parses to nothing at all', () => {
    expect(parseDiff('')).toEqual({ rows: [], added: 0, removed: 0, binary: false, truncated: 0 })
  })

  it('caps the rendered rows but still counts the whole diff', () => {
    const body = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')
    const parsed = parseDiff(`@@ -0,0 +1,50 @@\n${body}\n`, 11)
    expect(parsed.rows).toHaveLength(11) // the hunk header plus ten lines
    expect(parsed.truncated).toBe(40)
    // The header's figures describe the diff, not the part that fit.
    expect(parsed.added).toBe(50)
  })

  it('renders an untracked file through the same path, numbered from 1', () => {
    const parsed = parseDiff(untrackedDiff('alpha\nbeta\n'))
    expect(parsed.added).toBe(2)
    expect(parsed.rows.map((r) => [r.kind, r.newNo, r.text])).toEqual([
      ['hunk', undefined, '@@ -0,0 +1,2 @@'],
      ['add', 1, 'alpha'],
      ['add', 2, 'beta'],
    ])
  })
})

describe('a hunk that knows its content but not its offset', () => {
  // A transcript's file-edit is a real diff with no line numbers in it: the
  // chat opens the sheet on one, and inventing a gutter would be worse than
  // leaving it empty.
  const parsed = parseDiff(['@@ @@ a.ts', ' ctx', '-old', '+new'].join('\n'))

  it('renders the change', () => {
    expect(parsed.rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'del', 'add'])
    expect(parsed.added).toBe(1)
    expect(parsed.removed).toBe(1)
    expect(parsed.rows[0]?.context).toBe('a.ts')
  })

  it('gives no line numbers rather than wrong ones', () => {
    for (const row of parsed.rows) {
      expect(row.oldNo).toBeUndefined()
      expect(row.newNo).toBeUndefined()
    }
  })

  it('numbers nothing when there is no header at all', () => {
    // A single-place edit needs no header — and got a gutter counting from 0
    // when the counters started there instead of at "unknown".
    const bare = parseDiff([' ctx', '-old', '+new'].join('\n'))
    expect(bare.rows.every((r) => r.oldNo === undefined && r.newNo === undefined)).toBe(true)
  })

  it('still numbers a NUMBERED hunk that follows it', () => {
    const mixed = parseDiff(['@@ @@ a.ts', '+x', '@@ -12,2 +12,2 @@', ' y'].join('\n'))
    expect(mixed.rows[1]?.newNo).toBeUndefined()
    expect(mixed.rows[3]?.newNo).toBe(12)
  })
})

describe('splitPath', () => {
  it('splits a path into its folder and its file name', () => {
    expect(splitPath('apps/web/src/a.ts')).toEqual({ dir: 'apps/web/src', name: 'a.ts' })
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })
  it('keeps an untracked folder’s slash on its name, so the row is never blank', () => {
    expect(splitPath('.artifacts/POD-1/')).toEqual({ dir: '.artifacts', name: 'POD-1/' })
    expect(splitPath('build/')).toEqual({ dir: '', name: 'build/' })
  })
})
