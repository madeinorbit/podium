/**
 * What the dock's history has to get right (POD-1289).
 *
 * A commit row used to be inert text: proof that an agent had done something,
 * with no way to ask what. So the row unfolds to the files that commit touched,
 * and a file in there opens the same diff sheet the working tree opens — read
 * out of the commit, because `git diff HEAD` answers "nothing changed" about
 * anything already committed, which is the exact case the unfold exists for.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitPanelView } from './GitPanelView'

const LOG = [
  'abc1234\tabc1234ffff\t2026-08-18T09:00:00+02:00\tAda\tThe collapsed column breathes',
  'def5678\tdef5678aaaa\t2026-08-17T09:00:00+02:00\tAda\tA warning that found nothing',
].join('\n')

const gitStatus = vi.fn(async () => ({
  ok: true,
  output: '## issue/1289-unfold\n M src/live.ts\n',
}))
const gitLog = vi.fn(async () => ({ ok: true, output: `${LOG}\n` }))
const gitCommitFiles = vi.fn(async ({ sha }: { sha: string }) => ({
  ok: true,
  output: sha === 'abc1234ffff' ? 'M\tsrc/a.ts\nA\tsrc/deep/b.ts\n' : 'M\tsrc/other.ts\n',
}))
const gitCommitDiffFile = vi.fn(async ({ path }: { sha: string; path: string }) => ({
  ok: true,
  output: [
    `diff --git a/${path} b/${path}`,
    '@@ -1,2 +1,3 @@',
    ' context',
    '+  const next = 2',
    '',
  ].join('\n'),
}))
const gitDiffFile = vi.fn(async () => ({ ok: true, output: '' }))
const readFileScoped = vi.fn(async () => ({ ok: true, content: '' }))
const uiState = {
  get: (): string | null => null,
  set: (): void => {},
  subscribe: (): (() => void) => () => {},
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) =>
    sel({
      gitStatus,
      gitLog,
      gitCommitFiles,
      gitCommitDiffFile,
      gitDiffFile,
      readFileScoped,
      uiState,
    }),
}))

afterEach(() => {
  cleanup()
  gitCommitFiles.mockClear()
  gitCommitDiffFile.mockClear()
  gitDiffFile.mockClear()
})

const panel = () => render(<GitPanelView cwd="/w/1289" />)
const commitRow = (subject: string): Promise<HTMLElement> =>
  screen.findByRole('button', { name: new RegExp(subject) })

describe('GitPanelView history', () => {
  it('unfolds a commit to its files, and folds it back without asking git twice', async () => {
    panel()
    const row = await commitRow('The collapsed column breathes')
    expect(row.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByTitle(/src\/deep\/b\.ts/)).toBeTruthy()
    // The other commit is untouched: unfolding is per row, not a mode.
    expect(gitCommitFiles.mock.calls.map((c) => c[0].sha)).toEqual(['abc1234ffff'])
    expect(screen.queryByTitle(/src\/other\.ts/)).toBeNull()

    // A sha IS its content, so the answer can never go stale — refolding keeps
    // it and the second look costs nothing.
    await userEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(row)
    await screen.findByTitle(/src\/deep\/b\.ts/)
    expect(gitCommitFiles).toHaveBeenCalledTimes(1)
  })

  it('a file under a commit opens the diff sheet, reading from that commit', async () => {
    panel()
    await userEvent.click(await commitRow('A warning that found nothing'))
    await userEvent.click(await screen.findByTitle(/src\/other\.ts/))

    expect(await screen.findByTestId('diff-sheet')).toBeTruthy()
    // The sheet names the commit it is reading, not the branch.
    expect(document.querySelector('.diff-sheet-subject')?.textContent).toBe(
      'A warning that found nothing',
    )
    await waitFor(() => {
      expect(gitCommitDiffFile).toHaveBeenCalledWith(
        expect.objectContaining({ sha: 'def5678aaaa', path: 'src/other.ts', root: '/w/1289' }),
      )
    })
    expect(gitDiffFile).not.toHaveBeenCalled()
  })

  it('says what went wrong on the row that asked, not over the whole panel', async () => {
    gitCommitFiles.mockImplementationOnce(async () => ({ ok: false, output: 'bad object' }))
    panel()
    await userEvent.click(await commitRow('The collapsed column breathes'))
    expect(await screen.findByText('bad object')).toBeTruthy()
    // The working-tree half is untouched by a commit that could not be read.
    expect(screen.getByTitle(/src\/live\.ts/)).toBeTruthy()
  })
})
