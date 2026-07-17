// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/protocol'
import { act, type JSX, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeDeck, type DeckTab } from './panel-deck'

// Mount/unmount log keyed by sessionId, recorded by the stubbed AgentPanel below.
// Proves the deck preserves a panel's component IDENTITY across an issue switch:
// a session that moves between the tab group and the foreign-warm group must NOT
// remount (that would dispose the xterm/WebGL + the POD-725 transcript window).
const events: string[] = []

vi.mock('@/features/terminal/AgentPanel', () => ({
  AgentPanel: ({ sessionId, active }: { sessionId: string; active?: boolean }): JSX.Element => {
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

function renderDeck(opts: {
  tabs: DeckTab[]
  warm: Set<string>
  known: Set<string>
  paneA: string | null
}): void {
  const items = composeDeck({
    tabs: opts.tabs,
    warm: opts.warm,
    knownSessionIds: opts.known,
    paneA: opts.paneA,
    paneB: null,
    split: false,
  })
  act(() => {
    root.render(<PanelDeck items={items} split={false} onCloseFile={() => {}} />)
  })
}

function panelEl(id: string): HTMLElement | null {
  return container.querySelector(`[data-panel="${id}"]`)
}

describe('PanelDeck across issue switches', () => {
  it('(a,b) keeps s1 mounted through A→B→A without a remount, revealing it warm', () => {
    // Issue A: only s1, active.
    renderDeck({
      tabs: [sessionTab('s1')],
      warm: new Set(['s1']),
      known: new Set(['s1']),
      paneA: 's1',
    })
    expect(events).toEqual(['mount:s1'])
    expect(panelEl('s1')?.getAttribute('data-active')).toBe('true')

    // Switch to issue B: s2 mounts and becomes active; s1 rides along as a hidden
    // foreign warm panel — it must STAY MOUNTED.
    renderDeck({
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
    renderDeck({
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

  it('(d) unmounts a foreign panel whose session is archived/killed', () => {
    // s1 warm-foreign while viewing s2.
    renderDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      known: new Set(['s1', 's2']),
      paneA: 's2',
    })
    // Prime both mounts (s2 first render, then s1 foreign — order not asserted).
    expect(panelEl('s1')).not.toBeNull()

    // s1 archived/killed → leaves the known live set → its foreign panel drops.
    renderDeck({
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

  it('a cold local tab (not visible, not warm) renders nothing', () => {
    // s2 is a current tab but neither visible nor warm — it must not mount.
    renderDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1']),
      known: new Set(['s1', 's2']),
      paneA: 's1',
    })
    expect(panelEl('s1')).not.toBeNull()
    expect(panelEl('s2')).toBeNull()
  })
})
