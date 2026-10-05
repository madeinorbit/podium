// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TableFilePanel } from './TableFilePanel'

const documentState = vi.hoisted(() => ({ content: '' }))
vi.mock('./useFileDocument', () => ({
  useFileDocument: () => ({
    status: 'ready',
    content: documentState.content,
    editable: true,
    dirty: false,
    saving: false,
    saveFeedback: null,
    setContent: vi.fn(),
    save: vi.fn(),
  }),
}))
vi.mock('./SourceEditor', () => ({ SourceEditor: () => null }))
vi.mock('./OpenInBrowserButton', () => ({ OpenInBrowserButton: () => null }))
vi.mock('./DownloadFileButton', () => ({ DownloadFileButton: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const panel = (path = '/repo/data.csv') => (
  <TableFilePanel
    scope={{ kind: 'session', sessionId: asSessionId('s1') }}
    path={path}
    onClose={vi.fn()}
  />
)

async function filter(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter rows' }), { target: { value } })
  })
}

describe('TableFilePanel search ownership', () => {
  it('keeps exact counts, reuses search on sort changes, and clears without searching cells', async () => {
    documentState.content = `name,count\n${Array.from({ length: 650 }, (_, i) => `cell-${i},${650 - i}`).join('\n')}`
    const lower = vi.spyOn(String.prototype, 'toLocaleLowerCase')
    const cellSearches = () =>
      lower.mock.contexts.filter((value) => String(value).startsWith('cell-')).length
    render(panel())
    expect(screen.getByRole('status', { name: 'Table row count' }).textContent).toContain(
      '650 rows · 2 columns · showing 500 rows',
    )
    expect(cellSearches()).toBe(0)

    await filter(' CELL- ')
    expect(cellSearches()).toBe(650)
    fireEvent.click(screen.getByRole('button', { name: 'count' }))
    const firstRow = () =>
      screen.getByTestId('table-file-viewer').querySelector('tbody tr')?.textContent
    expect(firstRow()).toBe('1cell-6491')
    fireEvent.click(screen.getByRole('button', { name: 'count' }))
    expect(firstRow()).toBe('1cell-0650')
    fireEvent.click(screen.getByRole('button', { name: 'count' }))
    expect(firstRow()).toBe('1cell-0650')
    expect(cellSearches()).toBe(650)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear row filter' }))
    })
    expect(cellSearches()).toBe(650)
    expect(screen.getByRole('textbox', { name: 'Filter rows' })).toHaveProperty('value', '')
  })

  it('replaces search ownership on content and file changes while preserving the query', async () => {
    documentState.content = 'name,count\nalpha,1\nneedle,3'
    const view = render(panel())
    await filter('needle')
    expect(screen.getByRole('status', { name: 'Table row count' }).textContent).toBe('1 of 2 rows')
    expect(screen.getByTestId('table-file-viewer').textContent).toContain('needle')

    documentState.content = 'name,count\nnew needle,2\nother,4\nneedle again,5'
    await act(async () => {
      view.rerender(panel())
    })
    expect(screen.getByRole('status', { name: 'Table row count' }).textContent).toBe('2 of 3 rows')
    expect(screen.getByTestId('table-file-viewer').textContent).toContain('needle again')

    documentState.content = 'name\tcount\nno match\t1'
    await act(async () => {
      view.rerender(panel('/repo/data.tsv'))
    })
    expect(screen.getByRole('status', { name: 'Table row count' }).textContent).toBe('0 of 1 rows')
    expect(screen.getByTestId('table-file-viewer').textContent).toContain('No rows match "needle".')
  })

  it('declares capped search scope and finds matches outside the displayed window', async () => {
    const headers = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',')
    documentState.content = `${headers}\n${Array.from({ length: 100 }, () => 'ordinary').join(',')},NEEDLE`
    render(panel())
    expect(screen.getByRole('status', { name: 'Table row count' }).textContent).toContain(
      'search covers preview only',
    )
    await filter('needle')
    expect(screen.getByRole('status', { name: 'Table row count' }).textContent).toContain('1 rows')
    expect(screen.getByTestId('table-file-viewer').querySelectorAll('tbody tr')).toHaveLength(1)
    expect(screen.getByTestId('table-file-viewer').textContent).not.toContain('NEEDLE')
  })
})
