// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoScanResults } from './RepoScanResults'
import type { RepoCandidate } from './ranking'

function candidate(over: Partial<RepoCandidate> & { path: string }): RepoCandidate {
  return {
    name: over.path.split('/').filter(Boolean).pop() ?? over.path,
    hasOrigin: false,
    hidden: false,
    worktreeCount: 0,
    ...over,
  }
}

const registered = candidate({ path: '/home/u/known', status: 'registered' })
const auto = candidate({ path: '/home/u/auto', status: 'auto-registered' })
const fresh = candidate({ path: '/home/u/fresh', status: 'candidate' })
const spare = candidate({ path: '/home/u/other', status: 'candidate' })

function renderResults(candidates: RepoCandidate[], onApply = vi.fn()) {
  render(
    <RepoScanResults
      scannedPath="vmi34"
      candidates={candidates}
      saving={false}
      error={null}
      onApply={onApply}
      onBack={() => {}}
    />,
  )
  return onApply
}

/** Rows toggle by clicking their label — anywhere on the row's text. */
function toggleRow(c: RepoCandidate): void {
  fireEvent.click(screen.getByText(c.name))
}

const checkState = (c: RepoCandidate): string | null =>
  screen.getByLabelText(c.path).getAttribute('aria-checked')

/** The confirm button. Matched by its full label so a section's "Remove all"
 *  bulk control (which also starts with "Remove") can't be mistaken for it. */
const footer = (): HTMLButtonElement => {
  const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[]
  const btn = buttons.find((b) =>
    /^(Add \d|Remove \d|Add \d+ · Remove \d+|No changes|Saving)/.test(b.textContent ?? ''),
  )
  if (!btn) throw new Error(`no footer button among: ${buttons.map((b) => b.textContent)}`)
  return btn
}

/** The verdict chip on a row (null when the row is simply ignored). */
const fateOf = (c: RepoCandidate): string | undefined => {
  // The row is `<checkbox> <label(name, path)> <chips>` inside one grid div.
  const row = screen.getByLabelText(c.path).parentElement
  if (row?.textContent?.includes('will be removed')) return 'will be removed'
  if (row?.textContent?.includes('will be added')) return 'will be added'
  if (row?.textContent?.includes('added automatically')) return 'added automatically'
  if (row?.textContent?.includes('added')) return 'added'
  return undefined
}

afterEach(cleanup)

describe('RepoScanResults selection model', () => {
  it('preselects nothing except the repos already added — a scan never volunteers repos', () => {
    renderResults([registered, auto, fresh, spare])

    expect(checkState(registered)).toBe('true')
    expect(checkState(auto)).toBe('true')
    // The fix for "it preselected a backup copy": candidates start UNchecked.
    expect(checkState(fresh)).toBe('false')
    expect(checkState(spare)).toBe('false')
    expect(footer().textContent).toBe('No changes')
    expect(footer().disabled).toBe(true)
  })

  it('groups rows by what they are — already added vs found', () => {
    renderResults([registered, fresh])
    expect(screen.getByText(/ALREADY ADDED/)).toBeTruthy()
    expect(screen.getByText(/FOUND — NOT ADDED YET/)).toBeTruthy()
  })

  it('spells out each row fate: added, will be added, will be removed', () => {
    renderResults([registered, fresh])
    expect(fateOf(registered)).toBe('added')
    expect(fateOf(fresh)).toBeUndefined() // untouched candidate — no noisy chip

    toggleRow(fresh)
    expect(fateOf(fresh)).toBe('will be added')

    toggleRow(registered)
    expect(fateOf(registered)).toBe('will be removed')
  })

  it('leaves already-added rows toggleable (not locked)', () => {
    renderResults([registered])
    expect(screen.getByLabelText(registered.path).hasAttribute('disabled')).toBe(false)
    toggleRow(registered)
    expect(checkState(registered)).toBe('false')
  })

  it('toggles from a click on the checkbox itself, not only on the row text', () => {
    // A <label> wrapping the checkbox used to swallow this exact click.
    renderResults([registered, fresh])
    fireEvent.click(screen.getByLabelText(fresh.path))
    expect(checkState(fresh)).toBe('true')
    expect(footer().textContent).toBe('Add 1')
  })

  it('counts a checked candidate as an add and an unchecked registered row as a removal', () => {
    renderResults([registered, auto, fresh])
    toggleRow(fresh) // add
    toggleRow(auto) // remove
    expect(footer().textContent).toBe('Add 1 · Remove 1')
  })

  it('applies the add/remove diff rather than the raw selection', () => {
    const onApply = renderResults([registered, auto, fresh, spare])

    toggleRow(registered) // already added → remove
    toggleRow(spare) // candidate → add
    fireEvent.click(footer())

    expect(onApply).toHaveBeenCalledWith({ add: [spare.path], remove: [registered.path] })
  })

  it('re-checking a row you just unchecked cancels its removal', () => {
    renderResults([registered, auto])
    toggleRow(registered)
    expect(footer().textContent).toBe('Remove 1')
    toggleRow(registered)
    expect(footer().textContent).toBe('No changes')
  })
})

describe('RepoScanResults bulk controls name their consequence', () => {
  it('found rows select all / clear — never touching the removal path', () => {
    renderResults([registered, fresh, spare])
    fireEvent.click(screen.getByRole('button', { name: /Select all 2/ }))
    expect(footer().textContent).toBe('Add 2')
    // The added repo is untouched — bulk-selecting candidates cannot remove it.
    expect(checkState(registered)).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(footer().textContent).toBe('No changes')
  })

  it('already-added rows use a destructive "Remove all", not an opaque "none"', () => {
    renderResults([registered, auto])
    // No generic "none" button that silently drops your repos.
    expect(screen.queryByRole('button', { name: 'none' })).toBeNull()
    const removeAll = screen.getByRole('button', { name: 'Remove all' })
    fireEvent.click(removeAll)
    expect(footer().textContent).toBe('Remove 2')
    // And the footer says, in words, that this deletes.
    expect(screen.getByText(/to remove from Podium/)).toBeTruthy()
  })
})
