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
    render(<AppErrorPage message="boom" />)
    expect(container.textContent).toContain('agents')
    expect(container.textContent?.toLowerCase()).toContain('uninterrupted')
  })

  it('always offers a reload, even with no retry handler', () => {
    render(<AppErrorPage message="boom" />)
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toContain('Reload Podium')
  })

  it('reloads the document mechanically when the reload button is pressed', () => {
    const reload = vi.fn()
    render(<AppErrorPage message="boom" win={{ location: { reload, href: '/x' } }} />)
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reload Podium',
    )
    act(() => button?.click())
    expect(reload).toHaveBeenCalledTimes(1)
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
