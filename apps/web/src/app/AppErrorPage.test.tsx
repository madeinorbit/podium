import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppErrorPage, reloadApp } from './AppErrorPage'

describe('AppErrorPage', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function render(node: React.ReactNode): void {
    act(() => root.render(node))
  }

  it('reassures the operator that agents keep running while the UI is down', () => {
    render(<AppErrorPage />)
    expect(container.textContent).toContain('agents')
    expect(container.textContent?.toLowerCase()).toContain('uninterrupted')
  })

  it('always offers a reload, even with no retry handler', () => {
    render(<AppErrorPage message="boom" />)
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toContain('Reload interface')
  })

  it('reloads the document mechanically when the reload button is pressed', () => {
    const reload = vi.fn()
    render(<AppErrorPage message="boom" win={{ location: { reload, href: '/x' } }} />)
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reload interface',
    )
    act(() => button?.click())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps an actionable message in plain sight rather than behind the disclosure', () => {
    render(<AppErrorPage message="Restart the relay from this branch." />)
    expect(container.querySelector('details')).toBeNull()
    expect(container.textContent).toContain('Restart the relay from this branch.')
  })

  it('tucks raw diagnostic detail behind "What happened"', () => {
    render(<AppErrorPage detail="TypeError: e.kind" />)
    const details = container.querySelector('details')
    expect(details?.textContent).toContain('TypeError: e.kind')
    expect(details?.open).toBe(false)
  })

  it('marks the disclosure as one, so the label does not read as a heading', () => {
    render(<AppErrorPage detail="TypeError: e.kind" />)
    // The default marker is suppressed (the label is mono small-caps and the
    // triangle sat wrong against it), so the affordance has to be drawn: an
    // icon inside the summary, turned by the open state. Without it the row is
    // indistinguishable from the section labels above it [POD-1298]. The turn
    // is a CSS rule on `.boot-detail[open]` since POD-1304, so what is asserted
    // here is the icon and the hook it turns on, not a utility class.
    const summary = container.querySelector('summary')
    expect(summary?.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('details')?.className).toContain('boot-detail')
  })

  it('reloads on R, so the crash screen is exit-able without a mouse', () => {
    const reload = vi.fn()
    render(<AppErrorPage detail="boom" win={{ location: { reload, href: '/x' } }} />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves R alone while the operator is typing', () => {
    const reload = vi.fn()
    render(<AppErrorPage detail="boom" win={{ location: { reload, href: '/x' } }} />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    input.remove()
    expect(reload).not.toHaveBeenCalled()
  })

  it('falls back to a same-URL navigation when reload() itself throws', () => {
    const assigned: string[] = []
    const location = {
      get href(): string {
        return '/current'
      },
      set href(next: string) {
        assigned.push(next)
      },
      reload: () => {
        throw new Error('reload unavailable')
      },
    }
    reloadApp({ location })
    expect(assigned).toEqual(['/current'])
  })
})
