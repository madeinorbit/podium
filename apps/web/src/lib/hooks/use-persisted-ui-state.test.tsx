// @vitest-environment happy-dom

import type { UiState } from '@podium/client-core/replica'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { usePersistedUiStateFrom } from './use-persisted-ui-state'

function memoryUi(seed: Record<string, string> = {}): UiState {
  const data = new Map<string, string>(Object.entries(seed))
  const listeners = new Set<() => void>()
  return {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      if (value === null) data.delete(key)
      else data.set(key, value)
      for (const cb of listeners) cb()
    },
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

function Probe({
  ui,
  storageKey,
  parse,
}: {
  ui: Pick<UiState, 'get' | 'subscribe'>
  storageKey: string
  parse: (raw: string | null) => string
}): JSX.Element {
  const value = usePersistedUiStateFrom(ui, storageKey, parse)
  return <div data-testid="value">{value}</div>
}

const asCollapsed = (raw: string | null): string => (raw === 'true' ? 'collapsed' : 'expanded')

describe('usePersistedUiStateFrom', () => {
  afterEach(cleanup)

  it('reads the current value on mount', () => {
    const ui = memoryUi({ 'podium:sidebar:collapsed': 'true' })
    render(<Probe ui={ui} storageKey="podium:sidebar:collapsed" parse={asCollapsed} />)
    expect(screen.getByTestId('value').textContent).toBe('collapsed')
  })

  it('falls back while the key is absent, then adopts the value when the replica row arrives', () => {
    // The REPLICATED-layout race: first paint has no row; subscribe fires when
    // the feed (or a late hydrate) lands the stored value.
    const ui = memoryUi()
    render(<Probe ui={ui} storageKey="podium:sidebar:collapsed" parse={asCollapsed} />)
    expect(screen.getByTestId('value').textContent).toBe('expanded')

    act(() => {
      ui.set('podium:sidebar:collapsed', 'true')
    })
    expect(screen.getByTestId('value').textContent).toBe('collapsed')
  })

  it('tracks external writes without a local useState mirror', () => {
    const ui = memoryUi({ 'podium.dock.section.git': '1' })

    function Writer(): JSX.Element {
      const open = usePersistedUiStateFrom(ui, 'podium.dock.section.git', (raw) =>
        raw === null ? true : raw === '1',
      )
      return (
        <button type="button" onClick={() => ui.set('podium.dock.section.git', open ? '0' : '1')}>
          {open ? 'open' : 'closed'}
        </button>
      )
    }

    render(<Writer />)
    const button = screen.getByRole('button')
    expect(button.textContent).toBe('open')
    act(() => {
      button.click()
    })
    expect(button.textContent).toBe('closed')
    expect(ui.get('podium.dock.section.git')).toBe('0')
    act(() => {
      button.click()
    })
    expect(button.textContent).toBe('open')
  })

  it('does not freeze the first parse the way a useState initializer would', () => {
    // Contrast: a useState seed captures the absent default forever even after
    // the key is written underneath.
    const ui = memoryUi()

    function Seeded(): JSX.Element {
      const [frozen] = useState(() => (ui.get('k') === '1' ? 'from-store' : 'default'))
      return <div data-testid="seeded">{frozen}</div>
    }
    function Subscribed(): JSX.Element {
      const value = usePersistedUiStateFrom(ui, 'k', (raw) =>
        raw === '1' ? 'from-store' : 'default',
      )
      return <div data-testid="subscribed">{value}</div>
    }

    render(
      <>
        <Seeded />
        <Subscribed />
      </>,
    )
    expect(screen.getByTestId('seeded').textContent).toBe('default')
    expect(screen.getByTestId('subscribed').textContent).toBe('default')

    act(() => {
      ui.set('k', '1')
    })
    // Seeded is stuck; subscribed follows the store.
    expect(screen.getByTestId('seeded').textContent).toBe('default')
    expect(screen.getByTestId('subscribed').textContent).toBe('from-store')
  })
})
