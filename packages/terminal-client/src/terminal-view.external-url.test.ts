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
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

/** Mount a TerminalView, write `text`, and activate the first detected link. */
async function activateFirstLink(text: string): Promise<void> {
  const providers: ILinkProvider[] = []
  vi.spyOn(Terminal.prototype, 'registerLinkProvider').mockImplementation(
    (provider: ILinkProvider): IDisposable => {
      providers.push(provider)
      return { dispose() {} }
    },
  )
  const view = new TerminalView()
  const term = (view as unknown as { term: Terminal }).term
  await write(term, text)

  const provider = providers[0]
  if (!provider) throw new Error('URL link provider was not registered')
  let links: ILink[] | undefined
  provider.provideLinks(1, (found) => {
    links = found
  })
  const link = links?.[0]
  if (!link) throw new Error('URL link was not provided')
  link.activate(new Event('click') as MouseEvent, link.text)
  view.dispose()
}

function write(term: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => term.write(text, resolve))
}

describe('TerminalView external URL activation', () => {
  it('uses window.open with _blank as the primary handoff', async () => {
    const openedWindow = { opener: {} }
    const opened = vi.fn(() => openedWindow)
    Object.defineProperty(window, 'open', { value: opened, configurable: true })

    await activateFirstLink('https://example.com/pwa-link')

    expect(opened).toHaveBeenCalledWith('https://example.com/pwa-link', '_blank')
    expect(openedWindow.opener).toBeNull()
  })

  it('hands the URL to the Tauri opener plugin instead of window.open', async () => {
    const opened = vi.fn(() => ({ opener: {} }))
    Object.defineProperty(window, 'open', { value: opened, configurable: true })
    const invoke = vi.fn(() => Promise.resolve())
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }

    await activateFirstLink('https://example.com/tauri-link')

    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://example.com/tauri-link',
    })
    expect(opened).not.toHaveBeenCalled()
  })
})
