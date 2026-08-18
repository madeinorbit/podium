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
import { DIFF_SHEET_WRAP_KEY } from '@podium/client-core/ui-state'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffSheet } from './DiffSheet'
import { parseCommitFiles, parseStatus } from './git-panel'

const { entries } = parseStatus(
  [
    '## issue/787-diff',
    'M  src/a.ts',
    ' M src/deep/b.ts',
    '?? notes.md',
    '?? shot.png',
    '?? out/',
  ].join('\n'),
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
const gitCommitDiffFile = vi.fn(async ({ path }: { sha: string; path: string }) => ({
  ok: true,
  output: diffFor(path),
}))
const readFileScoped = vi.fn(async (_scope: unknown, path: string) =>
  path.endsWith('.png')
    ? { ok: false, path, binary: true }
    : { ok: true, content: 'alpha\nbeta\n' },
)

/**
 * The device-local ui-state collection, in memory. The wrap toggle is a
 * persisted key with a declared home (POD-329), not state this component owns,
 * so the sheet reads and writes it here rather than through storage of its own.
 */
const uiRows = new Map<string, string>()
const uiListeners = new Set<() => void>()
const uiState = {
  get: (key: string): string | null => uiRows.get(key) ?? null,
  set: (key: string, value: string | null): void => {
    if (value === null) uiRows.delete(key)
    else uiRows.set(key, value)
    for (const notify of [...uiListeners]) notify()
  },
  subscribe: (notify: () => void): (() => void) => {
    uiListeners.add(notify)
    return () => {
      uiListeners.delete(notify)
    }
  },
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) =>
    sel({ gitDiffFile, gitCommitDiffFile, readFileScoped, uiState }),
}))

afterEach(() => {
  cleanup()
  gitDiffFile.mockClear()
  gitCommitDiffFile.mockClear()
  readFileScoped.mockClear()
  uiRows.clear()
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

const COMMIT = { sha: 'abc1234ffff0000', shortSha: 'abc1234', subject: 'Teach the dock history' }
const commitEntries = parseCommitFiles(['M\tsrc/a.ts', 'A\tsrc/deep/b.ts'].join('\n'))

/** The same sheet, opened from an unfolded commit row instead of the tree. */
const openCommit = (initialPath: string) =>
  render(
    <DiffSheet
      cwd="/w/787"
      entries={commitEntries}
      commit={COMMIT}
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

  it('persists the wrap toggle as ui-state, so a reopened sheet reads it back', async () => {
    open('src/a.ts')
    await screen.findByText('function shape() {')
    const toggle = screen.getByTitle(/Wrap long lines/)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.diff-scroll')?.getAttribute('data-wrap')).toBe('on')
    // The declared key, in the collection — not a private localStorage row.
    expect(uiRows.get(DIFF_SHEET_WRAP_KEY)).toBe('1')

    // The preference outlives the sheet that set it: this is the whole reason
    // it is persisted rather than component state.
    cleanup()
    open('src/a.ts')
    await screen.findByText('function shape() {')
    expect(screen.getByTitle(/Wrap long lines/).getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * A COMMIT reads out of history [POD-1289]. The distinction the sheet has to
   * hold is that `git diff HEAD` — the working-tree question — answers "nothing
   * changed" about anything already committed, which is exactly the case the
   * unfold exists to show.
   */
  it('reads a commit out of history, never through the working-tree diff', async () => {
    openCommit('src/deep/b.ts')
    expect(await screen.findByText('function shape() {')).toBeTruthy()

    await waitFor(() => {
      expect(gitCommitDiffFile.mock.calls.map((c) => c[0].path).sort()).toEqual([
        'src/a.ts',
        'src/deep/b.ts',
      ])
    })
    expect(gitCommitDiffFile.mock.calls.every((c) => c[0].sha === COMMIT.sha)).toBe(true)
    // Not one worktree question asked about a file that is already in history.
    expect(gitDiffFile).not.toHaveBeenCalled()
    expect(readFileScoped).not.toHaveBeenCalled()
  })

  it('the commit names itself, and offers no re-probe for something immutable', async () => {
    openCommit('src/a.ts')
    await screen.findByText('function shape() {')
    // The reader came from ONE row of a log: the sheet says which.
    expect(screen.getByText(COMMIT.subject)).toBeTruthy()
    expect(screen.getByTitle(COMMIT.sha).textContent).toContain(COMMIT.shortSha)
    expect(screen.queryByTitle(/Re-read the working tree/)).toBeNull()
    // One axis, so a bare letter in the dim tone — never the staged colour.
    expect(row('src/a.ts').querySelector('.diff-tone-committed')?.textContent).toBe('M')
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
