import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardBoundary } from './CardBoundary'

function Boom(): never {
  throw new Error('render exploded')
}

describe('CardBoundary', () => {
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

  it('degrades one throwing card to a compact fallback instead of bubbling (blanking the app)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}) // silence React's boundary log
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => {
      root.render(
        <CardBoundary label="session card">
          <Boom />
        </CardBoundary>,
      )
    })
    expect(container.textContent).toContain('displayed')
  })

  it('logs the failure through the logger, naming the card and its component stack', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}) // silence React's boundary log
    const records: LogRecord[] = []
    setLogLevel('warn')
    // A real sink with no pinned level: the production mechanism, at the level
    // a deployment runs it at.
    addSink({ name: 'capture', write: (record) => records.push(record) })
    act(() => {
      root.render(
        <CardBoundary label="session card">
          <Boom />
        </CardBoundary>,
      )
    })

    const logged = records.find((r) => r.level === 'warn')
    expect(logged?.msg).toContain('render exploded')
    expect(logged?.label).toBe('session card')
    expect(logged?.componentStack).toContain('Boom')
    resetLogging()
  })

  it('renders children normally when they do not throw', () => {
    act(() => {
      root.render(
        <CardBoundary>
          <div>healthy card</div>
        </CardBoundary>,
      )
    })
    expect(container.textContent).toContain('healthy card')
  })
})
