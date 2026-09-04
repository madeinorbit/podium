// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useInlineRename } from './use-inline-rename'

afterEach(cleanup)

/**
 * THE COMMIT POLICY (POD-407) AND ITS SNAPSHOT (POD-1618).
 *
 * The policy is "trim, then no-op on empty or unchanged", and it exists because
 * a row opens its editor on DOUBLE-CLICK and the editor commits on BLUR: an
 * accidental double-click followed by a click elsewhere must not spend a write.
 *
 * What POD-1618 added is WHICH value "unchanged" is measured against. The name
 * a row shows can be derived from something a background agent owns — a draft
 * is named by its session, and an agent renames itself whenever it calls
 * `podium session title` — so the live value can move while the editor is open.
 */
describe('useInlineRename', () => {
  it('opens closed, and opening captures the value to show and to compare', () => {
    const onRename = vi.fn()
    const { result } = renderHook(() => useInlineRename('Original title', onRename))

    expect(result.current.editing).toBe(false)
    expect(result.current.seed).toBeNull()

    act(() => result.current.begin())

    expect(result.current.editing).toBe(true)
    expect(result.current.seed).toBe('Original title')
  })

  it('trims, and writes only a genuine change', () => {
    const onRename = vi.fn()
    const { result } = renderHook(() => useInlineRename('Original title', onRename))

    act(() => result.current.begin())
    act(() => result.current.commit('  Renamed issue  '))
    expect(onRename).toHaveBeenCalledWith('Renamed issue')
    expect(result.current.editing).toBe(false)

    onRename.mockClear()
    act(() => result.current.begin())
    act(() => result.current.commit('Original title'))
    expect(onRename).not.toHaveBeenCalled()

    act(() => result.current.begin())
    act(() => result.current.commit('   '))
    expect(onRename).not.toHaveBeenCalled()
  })

  // THE RACE THIS SNAPSHOT CLOSES. The field is uncontrolled: it holds the text
  // it was seeded with. Measured against the LIVE name, an agent renaming itself
  // while the editor sits open turns the fumble the policy absorbs into a write
  // — the operator's stale field no longer equals the live name, so blurring
  // commits a title nobody chose.
  it('measures a commit against the name the operator opened, not the live one', () => {
    const onRename = vi.fn()
    const { result, rerender } = renderHook(
      ({ current }: { current: string }) => useInlineRename(current, onRename),
      { initialProps: { current: 'Artifact directive provenance' } },
    )

    act(() => result.current.begin())
    // The agent renames ITSELF; the row's derived label follows it.
    rerender({ current: 'Artifact provenance, answered' })
    // ...and the operator clicks away from the field they never touched.
    act(() => result.current.commit('Artifact directive provenance'))

    expect(onRename).not.toHaveBeenCalled()
    expect(result.current.editing).toBe(false)
  })

  // The other half of the same rule: typing IS intent, even when what was typed
  // happens to match a name that arrived while the editor was open.
  it('still writes what the operator actually typed', () => {
    const onRename = vi.fn()
    const { result, rerender } = renderHook(
      ({ current }: { current: string }) => useInlineRename(current, onRename),
      { initialProps: { current: 'Artifact directive provenance' } },
    )

    act(() => result.current.begin())
    rerender({ current: 'Something else entirely' })
    act(() => result.current.commit('Something else entirely'))

    expect(onRename).toHaveBeenCalledWith('Something else entirely')
  })

  // Both entry points call `begin` — the double-click and the menu's Rename —
  // and the menu can be opened over an editor that is already up.
  it('keeps the first snapshot when begin runs again on an open editor', () => {
    const onRename = vi.fn()
    const { result, rerender } = renderHook(
      ({ current }: { current: string }) => useInlineRename(current, onRename),
      { initialProps: { current: 'Artifact directive provenance' } },
    )

    act(() => result.current.begin())
    rerender({ current: 'Renamed by its agent' })
    act(() => result.current.begin())

    expect(result.current.seed).toBe('Artifact directive provenance')
    act(() => result.current.commit('Artifact directive provenance'))
    expect(onRename).not.toHaveBeenCalled()
  })

  it('cancels without writing and closes', () => {
    const onRename = vi.fn()
    const { result } = renderHook(() => useInlineRename('Original title', onRename))

    act(() => result.current.begin())
    act(() => result.current.cancel())

    expect(onRename).not.toHaveBeenCalled()
    expect(result.current.editing).toBe(false)
    expect(result.current.seed).toBeNull()
  })
})
