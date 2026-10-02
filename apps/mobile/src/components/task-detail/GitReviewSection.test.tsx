import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../../client/test-support'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

const { DiffLine, GitReviewSection } = await import('./GitReviewSection')

afterEach(() => { cleanup(); storeStats.enable(false) })

describe('GitReviewSection accessibility', () => {
  it('uses the existing mobile owner with zero legacy derivations for status and diff reads', async () => {
    const status = vi.fn(async () => ({ ok: true, output: '## main\n M remote.ts' }))
    const diffFile = vi.fn(async () => ({ ok: true, output: '@@ -1 +1 @@\n-old\n+current' }))
    const owners = new Set<ClientRuntime>(), machineId = asMachineId('remote-host')
    function CaptureOwner() { owners.add(useStoreHandle() as ClientRuntime); return null }
    storeStats.enable(); storeStats.reset()
    const view = await renderWithMobileStore(<><CaptureOwner /><GitReviewSection root="/remote/repo" machineId={machineId} /></>, {
      api: { git: { status: { query: status }, diffFile: { query: diffFile } } },
    })
    fireEvent.click(await screen.findByLabelText('remote.ts, modified'))
    expect(await screen.findByLabelText('Added line: current')).toBeTruthy()
    await act(async () => view.emit('machines', []))
    fireEvent.click(screen.getByLabelText('Refresh changed files'))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(owners.size).toBe(1)
    expect(status).toHaveBeenCalledWith({ root: '/remote/repo', machineId })
    expect(diffFile).toHaveBeenCalledWith({ root: '/remote/repo', path: 'remote.ts', machineId })
    expect(storeStats.snapshot().runtimes.reduce((sum, row) => sum + row.selectorRuns + Object.values(row.slices).reduce((n, count) => n + count, 0), 0)).toBe(0)
  })
  it('renders added and deleted rows with explicit screen-reader semantics', () => {
    render(
      <>
        <DiffLine row={{ kind: 'add', text: 'const ready = true' }} />
        <DiffLine row={{ kind: 'del', text: 'const ready = false' }} />
      </>,
    )

    const added = screen.getByLabelText('Added line: const ready = true')
    const deleted = screen.getByLabelText('Deleted line: const ready = false')
    expect(added.getAttribute('aria-label')).toBe('Added line: const ready = true')
    expect(deleted.getAttribute('aria-label')).toBe('Deleted line: const ready = false')
    expect(added).not.toBe(deleted)
  })

  it('ignores a slow diff from the status generation before Refresh', async () => {
    const status = vi.fn(async () => ({
      ok: true,
      output: '## issue/1835\n M src/a.ts',
    }))
    let resolveOld: ((value: { ok: true; output: string }) => void) | undefined
    const diffFile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true; output: string }>((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValueOnce({ ok: true, output: '@@ -1 +1 @@\n-old\n+fresh' })

    await renderWithMobileStore(<GitReviewSection root="/repo" />, {
      api: { git: { status: { query: status }, diffFile: { query: diffFile } } },
    })
    const file = await screen.findByLabelText('src/a.ts, modified')
    fireEvent.click(file)
    await waitFor(() => expect(diffFile).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByLabelText('Refresh changed files'))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    await act(async () => resolveOld?.({ ok: true, output: '@@ -1 +1 @@\n-old\n+stale' }))

    fireEvent.click(await screen.findByLabelText('src/a.ts, modified'))
    await waitFor(() => expect(diffFile).toHaveBeenCalledTimes(2))
    expect(await screen.findByLabelText('Added line: fresh')).toBeTruthy()
  })

  it('combines both sides of a worktree-only rename through read-only contracts', async () => {
    const diffFile = vi.fn(async () => ({
      ok: true,
      output: '@@ -1 +0,0 @@\n-old contents',
    }))
    const readFile = vi.fn(async () => ({ ok: true, content: 'new contents\n' }))
    await renderWithMobileStore(<GitReviewSection root="/repo" />, {
      api: {
        git: {
          status: { query: async () => ({ ok: true, output: '## main\n R old.ts -> new.ts' }) },
          diffFile: { query: diffFile },
        },
        files: { read: { query: readFile } },
      },
    })

    fireEvent.click(await screen.findByLabelText('new.ts, renamed'))
    await waitFor(() => expect(diffFile).toHaveBeenCalledWith({ root: '/repo', path: 'old.ts' }))
    await waitFor(() =>
      expect(readFile).toHaveBeenCalledWith({ root: '/repo', path: 'new.ts' }),
    )
    expect(await screen.findByLabelText('Deleted line: old contents')).toBeTruthy()
    expect(await screen.findByLabelText('Added line: new contents')).toBeTruthy()
  })
})
