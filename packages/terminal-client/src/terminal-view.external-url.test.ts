// @vitest-environment happy-dom
import type { IDisposable, ILink, ILinkProvider } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TerminalView } from './terminal-view'

const originalOpenDescriptor = Object.getOwnPropertyDescriptor(window, 'open')

beforeAll(() => {
  // xterm's renderer touches ResizeObserver, which happy-dom lacks.
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalOpenDescriptor) {
    Object.defineProperty(window, 'open', originalOpenDescriptor)
  } else {
    Reflect.deleteProperty(window, 'open')
  }
})

function write(term: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => term.write(text, resolve))
}

describe('TerminalView external URL activation', () => {
  it('uses window.open with _blank as the primary handoff', async () => {
    const providers: ILinkProvider[] = []
    vi.spyOn(Terminal.prototype, 'registerLinkProvider').mockImplementation(
      (provider: ILinkProvider): IDisposable => {
        providers.push(provider)
        return { dispose() {} }
      },
    )
    const openedWindow = { opener: {} }
    const opened = vi.fn(() => openedWindow)
    Object.defineProperty(window, 'open', { value: opened, configurable: true })

    const view = new TerminalView()
    const term = (view as unknown as { term: Terminal }).term
    await write(term, 'https://example.com/pwa-link')

    const provider = providers[0]
    if (!provider) throw new Error('URL link provider was not registered')

    let links: ILink[] | undefined
    provider.provideLinks(1, (found) => {
      links = found
    })
    expect(links).toHaveLength(1)

    const link = links?.[0]
    if (!link) throw new Error('URL link was not provided')
    link.activate(new Event('click') as MouseEvent, link.text)

    expect(opened).toHaveBeenCalledWith('https://example.com/pwa-link', '_blank')
    expect(openedWindow.opener).toBeNull()
    view.dispose()
  })
})
