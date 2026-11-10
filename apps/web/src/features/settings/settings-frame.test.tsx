import type { SettingsPage } from '@podium/client-core/ui-state'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_PAGES, searchSettings } from './page-definitions'
import { Row } from './sections/shared'
import { SettingsPageSection } from './settings-anchors'
import { SettingsFrame, SettingsPageActions, useSettingsFrame } from './settings-frame'

const admin = {
  status: 'ready' as const,
  sections: ['people', 'access', 'machines', 'instance', 'audit'],
  retry: vi.fn(),
}
afterEach(cleanup)

function PageActions() {
  const { openTakeover } = useSettingsFrame()
  return (
    <SettingsPageActions>
      <button
        type="button"
        onClick={() =>
          openTakeover({
            title: 'Add project',
            description: 'Choose a repository.',
            content: <input aria-label="Repository URL" />,
          })
        }
      >
        Add project
      </button>
    </SettingsPageActions>
  )
}

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [page, setPage] = useState<SettingsPage>('agents')
  return (
    <SettingsFrame
      page={page}
      viewer={admin}
      onPageChange={(next) => setPage(next ?? 'agents')}
      onClose={onClose}
    >
      {page === 'projects' && (
        <>
          <PageActions />
          <SettingsPageSection id="workflow">
            <Row
              label="Default parent branch"
              description="New tasks branch from this in repositories without their own base branch."
            >
              <input aria-label="Default parent branch" />
            </Row>
          </SettingsPageSection>
        </>
      )}
    </SettingsFrame>
  )
}

describe('settings frame', () => {
  it('searches row help and keywords across pages, then focuses and highlights the row once', async () => {
    render(<Harness />)
    const input = screen.getByRole('searchbox', { name: 'Search settings' })
    fireEvent.change(input, { target: { value: 'without their own' } })
    expect(screen.getByRole('heading', { name: 'Results' })).toBeTruthy()
    const result = screen.getByRole('button', { name: 'Default parent branch Projects' })
    fireEvent.click(result)
    await waitFor(() =>
      expect(document.activeElement?.id).toBe('settings-workflow-default-parent-branch'),
    )
    const target = document.getElementById('settings-workflow-default-parent-branch')!
    expect(target.classList.contains('settings-search-highlight')).toBe(true)
    fireEvent.animationEnd(target)
    expect(target.classList.contains('settings-search-highlight')).toBe(false)
    expect((input as HTMLInputElement).value).toBe('')
    expect(
      screen.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'),
    ).toBe('page')
  })

  it('focuses search with slash and supports keyboard selection without closing the sheet', async () => {
    const close = vi.fn()
    render(<Harness onClose={close} />)
    fireEvent.keyDown(window, { key: '/' })
    const input = screen.getByRole('searchbox')
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'base branch' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(document.activeElement?.id).toBe('settings-workflow-default-parent-branch'),
    )
    expect(close).not.toHaveBeenCalled()
  })

  it('places page actions in the header and replaces the pane with a takeover', async () => {
    const close = vi.fn()
    render(<Harness onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: 'Projects', exact: true }))
    const action = await screen.findByRole('button', { name: 'Add project' })
    expect(action.closest('.settings-page-header')).toBeTruthy()
    fireEvent.click(action)
    const flow = screen.getByRole('region', { name: 'Add project' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toBeTruthy()
    fireEvent.keyDown(within(flow).getByRole('heading', { name: 'Add project' }), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Add project' })).toBeNull()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Add project' })).getByRole('button', {
        name: 'Projects',
      }),
    )
    expect(screen.queryByRole('textbox', { name: 'Repository URL' })).toBeNull()
  })

  it('does not steal slash from an editor', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Projects', exact: true }))
    const input = screen.getByRole('textbox', { name: 'Default parent branch' })
    act(() => input.focus())
    fireEvent.keyDown(input, { key: '/' })
    expect(document.activeElement).toBe(input)
  })
})

describe('settings search catalog', () => {
  it('indexes labels, help and keywords independently of the rendered page', () => {
    expect(
      searchSettings('garbage collection', SETTINGS_PAGES).some((r) => r.label === 'Worktree GC'),
    ).toBe(true)
    expect(
      searchSettings('run queue', SETTINGS_PAGES).some((r) => r.label === 'Load per core'),
    ).toBe(true)
    expect(
      searchSettings('telegram chat', SETTINGS_PAGES).some((r) => r.label === 'Telegram chat'),
    ).toBe(true)
    for (const page of SETTINGS_PAGES)
      expect(searchSettings(page.label, [page]).length).toBeGreaterThan(0)
  })
})
