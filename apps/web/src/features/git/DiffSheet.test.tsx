/**
 * What the sheet has to get right (POD-787):
 *
 *  1. It opens ON the file that was clicked — the dock's click is the reason it
 *     exists, and a viewer that opens on the first file instead makes the click
 *     a lie.
 *  2. Moving to another file is instant, because every file's diff was fetched
 *     while the first one was being read. The assertion is on the FETCH, not on
 *     the paint: prefetching is the whole reason the rail can show counts and
 *     the second click has nothing to wait for.
 *  3. An untracked file reads as a diff like any other — it goes through the
 *     file read and the synthesized hunk, and lands numbered from 1.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffSheet } from './DiffSheet'
import { parseStatus } from './git-panel'

const { entries } = parseStatus(
  ['## issue/787-diff', 'M  src/a.ts', ' M src/deep/b.ts', '?? notes.md', '?? shot.png', '?? out/'].join(
    '\n',
  ),
)

const diffFor = (path: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -4,3 +4,4 @@ function shape() {',
    ` // ${path}`,
    '-  const old = 1',
    '+  const next = 2',
    '+  const extra = 3',
    '',
  ].join('\n')

const gitDiffFile = vi.fn(async ({ path }: { path: string }) => ({
  ok: true,
  output: diffFor(path),
}))
// The real read refuses a binary blob by NAMING it — the sheet must not print
// that refusal as a failure.
const readFileScoped = vi.fn(async (_scope: unknown, path: string) =>
  path.endsWith('.png')
    ? { ok: false, path, binary: true }
    : { ok: true, content: 'alpha\nbeta\n' },
)

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) => sel({ gitDiffFile, readFileScoped }),
}))

afterEach(() => {
  cleanup()
  gitDiffFile.mockClear()
  readFileScoped.mockClear()
})

const open = (initialPath: string) =>
  render(
    <DiffSheet
      cwd="/w/787"
      entries={entries}
      branch="issue/787-diff"
      initialPath={initialPath}
      refreshing={false}
      onRefresh={() => {}}
      onClose={() => {}}
    />,
  )

/** Rail rows are options in one listbox; the path is how a test names one. */
const row = (path: string): HTMLElement => {
  const el = document.querySelector(`.diff-file[data-path="${path}"]`)
  if (!el) throw new Error(`no rail row for ${path}`)
  return el as HTMLElement
}

describe('DiffSheet', () => {
  it('opens on the clicked file and numbers both sides of its diff', async () => {
    open('src/deep/b.ts')
    expect(await screen.findByText('function shape() {')).toBeTruthy()

    expect(row('src/deep/b.ts').getAttribute('aria-current')).toBe('true')
    expect(document.querySelectorAll('.diff-file')).toHaveLength(entries.length)
    // The pane heads with the file, split so the name is the readable half.
    expect(screen.getByText('src/deep/')).toBeTruthy()

    const rows = document.querySelectorAll('.diff-row-add, .diff-row-del')
    expect([...rows].map((r) => r.textContent)).toEqual([
      '5−  const old = 1',
      '5+  const next = 2',
      '6+  const extra = 3',
    ])
  })

  it('prefetches every file, so the counts are real and the next click is instant', async () => {
    open('src/a.ts')
    // Every diffable entry, once each — and the folder, which has no diff to
    // ask for, never becomes a request.
    await waitFor(() => {
      expect(gitDiffFile.mock.calls.map((c) => c[0].path).sort()).toEqual([
        'src/a.ts',
        'src/deep/b.ts',
      ])
      expect(readFileScoped.mock.calls.map((c) => c[1]).sort()).toEqual(['notes.md', 'shot.png'])
    })
    // Two added, one removed — per file, in the rail, before it is opened.
    await waitFor(() => expect(row('src/deep/b.ts').textContent).toContain('+2'))
    expect(row('src/deep/b.ts').textContent).toContain('−1')

    await userEvent.click(row('src/deep/b.ts'))
    expect(row('src/deep/b.ts').getAttribute('aria-current')).toBe('true')
    expect(gitDiffFile).toHaveBeenCalledTimes(2) // nothing refetched
  })

  it('reads an untracked file as an all-added diff numbered from 1', async () => {
    open('notes.md')
    expect(await screen.findByText('alpha')).toBeTruthy()
    expect(readFileScoped).toHaveBeenCalledWith(
      { kind: 'worktree', machineId: undefined, root: '/w/787' },
      'notes.md',
    )
    const rows = [...document.querySelectorAll('.diff-row-add')].map((r) => r.textContent)
    expect(rows).toEqual(['1+alpha', '2+beta'])
  })

  it('states what an untracked folder is instead of failing to read it', async () => {
    open('out/')
    expect(await screen.findByText(/A new folder\./)).toBeTruthy()
    // Never a file read, and never a red error, for a folder behaving normally.
    expect(readFileScoped).not.toHaveBeenCalledWith(expect.anything(), 'out/')
    expect(document.querySelector('.diff-notice-error')).toBeNull()
    expect(row('out/').textContent).toContain('out/')
  })

  it('totals the tree once every entry has settled, binaries and folders included', async () => {
    open('src/a.ts')
    // 2 tracked files × (+2 −1), plus an untracked file's two added lines.
    const totals = await screen.findByTitle(/Lines added and removed/)
    expect(totals.textContent).toBe('+6−2')
  })

  it('names a binary file instead of reporting it as unreadable', async () => {
    open('shot.png')
    expect(await screen.findByText(/A binary file/)).toBeTruthy()
    expect(document.querySelector('.diff-notice-error')).toBeNull()
    // No counts on the rail row either: there is nothing to count.
    expect(row('shot.png').textContent).not.toContain('+')
  })

  it('walks the files with j and k', async () => {
    open('src/a.ts')
    await screen.findByText('function shape() {')
    await userEvent.keyboard('j')
    expect(row('src/deep/b.ts').getAttribute('aria-current')).toBe('true')
    await userEvent.keyboard('k')
    expect(row('src/a.ts').getAttribute('aria-current')).toBe('true')
  })
})
