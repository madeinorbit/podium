// @vitest-environment happy-dom
import type { SessionId, SessionMeta } from '@podium/model'
import { act, type JSX, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeDeck, type DeckTab } from './panel-deck'

// Mount/unmount log keyed by sessionId, recorded by the stubbed AgentPanel below.
// Proves the deck preserves a panel's component IDENTITY across an issue switch:
// a session that moves between the tab group and the foreign-warm group must NOT
// remount (that would dispose the xterm/WebGL + the POD-725 transcript window).
const events: string[] = []

vi.mock('@/features/terminal/AgentPanelBoundary', () => ({
  AgentPanelBoundary: ({
    sessionId,
    active,
  }: {
    sessionId: SessionId
    active?: boolean
  }): JSX.Element => {
    useEffect(() => {
      events.push(`mount:${sessionId}`)
      return () => {
        events.push(`unmount:${sessionId}`)
      }
    }, [sessionId])
    return <span data-panel={sessionId} data-active={String(!!active)} />
  },
}))

const { PanelDeck } = await import('./PanelDeck')

const sessionTab = (id: string): DeckTab => ({
  id,
  kind: 'session',
  session: { sessionId: id } as SessionMeta,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  events.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const FULL_BOX = { paneId: 'p1', left: 0, top: 0, width: 1, height: 1 }

/**
 * ASYNC BECAUSE THE PANEL BODY IS LAZY (POD-2730), and for no other reason.
 *
 * `PanelDeck` takes `AgentPanel` from `AgentPanelLazy`, so the FIRST render in
 * this file suspends while the stub module below resolves. An async `act` flushes
 * that; every assertion after it is unchanged, and the mount/unmount ledger those
 * assertions read is exactly as strict as it was — which is the point, because
 * what it guards (a warm panel must not remount, or the xterm/WebGL instance and
 * the POD-725 transcript window are disposed) is the property a lazy boundary
 * could plausibly have broken.
 *
 * Do not "fix" a suspension here by importing `AgentPanel` directly again: that
 * puts 1.2 MB back on the first paint. See DEFERRED_FIRST_PAINT_MODULES in
 * scripts/web-bundle-budget.ts, which fails the build if it happens.
 */
async function renderDeck(opts: {
  tabs: DeckTab[]
  warm: Set<string>
  known: Set<string>
  paneA: string | null
}): Promise<void> {
  const items = composeDeck({
    tabs: opts.tabs,
    warm: opts.warm,
    knownSessionIds: opts.known,
    panes: [{ id: 'p1', activeTabId: opts.paneA }],
  })
  await act(async () => {
    root.render(<PanelDeck items={items} panes={[FULL_BOX]} onCloseFile={() => {}} />)
  })
}

function panelEl(id: string): HTMLElement | null {
  return container.querySelector(`[data-panel="${id}"]`)
}

describe('PanelDeck across issue switches', () => {
  it('(a,b) keeps s1 mounted through A→B→A without a remount, revealing it warm', async () => {
    // Issue A: only s1, active.
    await renderDeck({
      tabs: [sessionTab('s1')],
      warm: new Set(['s1']),
      known: new Set(['s1']),
      paneA: 's1',
    })
    expect(events).toEqual(['mount:s1'])
    expect(panelEl('s1')?.getAttribute('data-active')).toBe('true')

    // Switch to issue B: s2 mounts and becomes active; s1 rides along as a hidden
    // foreign warm panel — it must STAY MOUNTED.
    await renderDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      known: new Set(['s1', 's2']),
      paneA: 's2',
    })
    expect(events).toEqual(['mount:s1', 'mount:s2'])
    // s1 still in the DOM, now inactive (hidden foreign panel).
    expect(panelEl('s1')).not.toBeNull()
    expect(panelEl('s1')?.getAttribute('data-active')).toBe('false')
    // Its wrapper is display:none (hidden), never claiming a visible pane.
    expect(panelEl('s1')?.closest('div.hidden')).not.toBeNull()
    expect(panelEl('s2')?.getAttribute('data-active')).toBe('true')

    // Back to issue A: s1 is revealed WITHOUT a fresh mount (identity preserved),
    // s2 becomes the hidden foreign panel.
    await renderDeck({
      tabs: [sessionTab('s1')],
      warm: new Set(['s1', 's2']),
      known: new Set(['s1', 's2']),
      paneA: 's1',
    })
    // No new mount:s1 and no unmount:s1 anywhere — s1 was never torn down.
    expect(events).toEqual(['mount:s1', 'mount:s2'])
    expect(panelEl('s1')?.getAttribute('data-active')).toBe('true')
    expect(panelEl('s2')?.getAttribute('data-active')).toBe('false')
  })

  it('(d) unmounts a foreign panel whose session is archived/killed', async () => {
    // s1 warm-foreign while viewing s2.
    await renderDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      known: new Set(['s1', 's2']),
      paneA: 's2',
    })
    // Prime both mounts (s2 first render, then s1 foreign — order not asserted).
    expect(panelEl('s1')).not.toBeNull()

    // s1 archived/killed → leaves the known live set → its foreign panel drops.
    await renderDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      known: new Set(['s2']),
      paneA: 's2',
    })
    expect(panelEl('s1')).toBeNull()
    expect(events).toContain('unmount:s1')
    // s2 was never disturbed.
    expect(events.filter((e) => e === 'unmount:s2')).toHaveLength(0)
  })

  it('a cold local tab (not visible, not warm) renders nothing', async () => {
    // s2 is a current tab but neither visible nor warm — it must not mount.
    await renderDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1']),
      known: new Set(['s1', 's2']),
      paneA: 's1',
    })
    expect(panelEl('s1')).not.toBeNull()
    expect(panelEl('s2')).toBeNull()
  })

  it('evicts through unmount and uses the existing cold remount route on reselect', async () => {
    const tabs = [sessionTab('s1'), sessionTab('s2')]
    await renderDeck({ tabs, warm: new Set(['s1']), known: new Set(['s1', 's2']), paneA: 's1' })
    await renderDeck({ tabs, warm: new Set(['s2']), known: new Set(['s1', 's2']), paneA: 's2' })
    expect(events).toEqual(['mount:s1', 'unmount:s1', 'mount:s2'])

    await renderDeck({ tabs, warm: new Set(['s1']), known: new Set(['s1', 's2']), paneA: 's1' })
    expect(events.filter((event) => event === 'mount:s1')).toHaveLength(2)
    expect(panelEl('s1')?.getAttribute('data-active')).toBe('true')
  })

  it('balances heavy-panel cleanup under StrictMode eviction', async () => {
    const tabs = [sessionTab('s1')]
    const items = composeDeck({
      tabs,
      warm: new Set(['s1']),
      knownSessionIds: new Set(['s1']),
      panes: [{ id: 'p1', activeTabId: 's1' }],
    })
    // Async for the same reason renderDeck is: the panel body is lazy, and this
    // test is only safe run alone if it flushes that first render itself.
    await act(async () => {
      root.render(
        <StrictMode>
          <PanelDeck items={items} panes={[FULL_BOX]} onCloseFile={() => {}} />
        </StrictMode>,
      )
    })
    const cold = composeDeck({
      tabs,
      warm: new Set(),
      knownSessionIds: new Set(['s1']),
      panes: [{ id: 'p1', activeTabId: null }],
    })
    await act(async () => {
      root.render(
        <StrictMode>
          <PanelDeck items={cold} panes={[]} onCloseFile={() => {}} />
        </StrictMode>,
      )
    })
    expect(events.filter((event) => event === 'mount:s1')).toHaveLength(2)
    expect(events.filter((event) => event === 'unmount:s1')).toHaveLength(2)
  })
})
