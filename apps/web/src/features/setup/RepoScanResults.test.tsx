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
    defaultSelected: false,
    ...over,
  }
}

const registered = candidate({ path: '/home/u/known', status: 'registered' })
const auto = candidate({ path: '/home/u/auto', status: 'auto-registered' })
const fresh = candidate({ path: '/home/u/fresh', status: 'candidate', defaultSelected: true })
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

const footer = (): HTMLButtonElement => {
  const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[]
  const btn = buttons.find((b) => /^(Add|Remove|No changes|Saving)/.test(b.textContent ?? ''))
  if (!btn) throw new Error(`no footer button among: ${buttons.map((b) => b.textContent)}`)
  return btn
}

afterEach(cleanup)

describe('RepoScanResults selection model', () => {
  it('starts registered and auto-registered rows checked, and leaves them toggleable', () => {
    renderResults([registered, auto, fresh, spare])

    expect(checkState(registered)).toBe('true')
    expect(checkState(auto)).toBe('true')
    expect(checkState(fresh)).toBe('true') // defaultSelected candidate
    expect(checkState(spare)).toBe('false')
    // The whole point: an already-added row is not locked.
    expect(screen.getByLabelText(registered.path).hasAttribute('disabled')).toBe(false)
    toggleRow(registered)
    expect(checkState(registered)).toBe('false')
  })

  it('toggles from a click on the checkbox itself, not only on the row text', () => {
    // A <label> wrapping the checkbox used to swallow this exact click: the box
    // toggled twice (once itself, once via the label) and nothing moved.
    renderResults([registered, fresh])
    fireEvent.click(screen.getByLabelText(registered.path))
    expect(checkState(registered)).toBe('false')
    expect(footer().textContent).toBe('Add 1 · Remove 1')
  })

  it('reports the diff, not the checked count — a pristine machine scan has no changes', () => {
    renderResults([registered, auto])
    expect(footer().textContent).toBe('No changes')
    expect(footer().disabled).toBe(true)
  })

  it('counts a checked candidate as an add', () => {
    renderResults([registered, fresh])
    expect(footer().textContent).toBe('Add 1')
    expect(footer().disabled).toBe(false)
  })

  it('counts an unchecked registered row as a removal, and both together', () => {
    renderResults([registered, auto, fresh])
    toggleRow(auto)
    expect(footer().textContent).toBe('Add 1 · Remove 1')
  })

  it('applies the add/remove diff rather than the raw selection', () => {
    const onApply = renderResults([registered, auto, fresh, spare])

    toggleRow(registered) // already added → remove
    toggleRow(spare) // candidate → add
    fireEvent.click(footer())

    expect(onApply).toHaveBeenCalledWith({
      add: [fresh.path, spare.path],
      remove: [registered.path],
    })
  })

  it('re-checking a row you just unchecked cancels its removal', () => {
    renderResults([registered, auto])
    toggleRow(registered)
    expect(footer().textContent).toBe('Remove 1')
    toggleRow(registered)
    expect(footer().textContent).toBe('No changes')
  })

  it('the section "none" button can clear every row, including registered ones', () => {
    renderResults([registered, auto, fresh])
    fireEvent.click(screen.getByRole('button', { name: 'none' }))
    expect(footer().textContent).toBe('Remove 2')
  })
})
