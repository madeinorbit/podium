import { describe, expect, it } from 'vitest'
import {
  activateTab,
  allTabIds,
  closePane,
  closeTab,
  deserializeWorkspaces,
  emptyWorkspace,
  focusPane,
  leafPaneIds,
  moveTab,
  openTab,
  paneOfTab,
  promoteTab,
  pruneWorkspace,
  resizeSplit,
  serializeWorkspaces,
  splitPane,
  type WorkspaceLayout,
  workspaceKeyFor,
} from './workspace-layout'

/**
 * The invariants from the POD-710 contract, asserted after EVERY operation
 * below. They are what the rest of the feature is allowed to assume: the strip
 * renders `panes[focusedPaneId]`, the italic tab is `previewTabId`, and both are
 * read without a null check.
 */
function expectInvariants(ws: WorkspaceLayout): void {
  const leaves = leafPaneIds(ws.root)
  expect(leaves.length, 'root always contains at least one leaf').toBeGreaterThan(0)
  expect(new Set(leaves).size, 'a pane appears once in the tree').toBe(leaves.length)
  expect(leaves, 'focusedPaneId names an existing leaf').toContain(ws.focusedPaneId)
  expect(Object.keys(ws.panes).sort(), 'no orphan panes').toEqual([...leaves].sort())
  const tabs = allTabIds(ws)
  expect(new Set(tabs).size, 'a tab id appears in at most one pane').toBe(tabs.length)
  for (const pane of Object.values(ws.panes)) {
    if (pane.activeTabId === null)
      expect(pane.tabs, 'only an empty pane has no active tab').toEqual([])
    else expect(pane.tabs, 'the active tab is a member of its pane').toContain(pane.activeTabId)
  }
  if (ws.previewTabId !== null) {
    expect(tabs, 'the preview tab is always open somewhere').toContain(ws.previewTabId)
  }
}

/** Apply an operation and assert the invariants survived it. */
function step(
  ws: WorkspaceLayout,
  op: (input: WorkspaceLayout) => WorkspaceLayout,
): WorkspaceLayout {
  const next = op(ws)
  expectInvariants(next)
  return next
}

const pane = (ws: WorkspaceLayout, id: string): { tabs: string[]; active: string | null } => ({
  tabs: ws.panes[id]?.tabs ?? [],
  active: ws.panes[id]?.activeTabId ?? null,
})

const preview = (ws: WorkspaceLayout, id: string): WorkspaceLayout =>
  step(ws, (w) => openTab(w, id, { permanent: false }))
const permanent = (ws: WorkspaceLayout, id: string): WorkspaceLayout =>
  step(ws, (w) => openTab(w, id, { permanent: true }))

describe('workspaceKeyFor', () => {
  it('prefers the mission root, then the issue, then the worktree', () => {
    expect(workspaceKeyFor({ missionRootId: 'iss_root', issueId: 'iss_child' })).toBe(
      'mission:iss_root',
    )
    expect(workspaceKeyFor({ issueId: 'iss_child', worktreePath: '/wt' })).toBe('issue:iss_child')
    expect(workspaceKeyFor({ worktreePath: '/wt' })).toBe('wt:/wt')
    expect(workspaceKeyFor({})).toBe('none')
    expect(workspaceKeyFor({ missionRootId: null, issueId: null, worktreePath: null })).toBe('none')
  })
})

describe('emptyWorkspace', () => {
  it('is a valid, renderable, empty layout', () => {
    const ws = emptyWorkspace('mission:m1')
    expectInvariants(ws)
    expect(ws.key).toBe('mission:m1')
    expect(allTabIds(ws)).toEqual([])
    expect(ws.previewTabId).toBeNull()
  })
})

describe('openTab — the preview tab', () => {
  it('reuses ONE temporary tab: a second preview replaces the first in place', () => {
    let ws = emptyWorkspace('k')
    ws = permanent(ws, 'kept')
    ws = preview(ws, 'a')
    expect(pane(ws, 'p1').tabs).toEqual(['kept', 'a'])
    ws = preview(ws, 'b')
    // same strip position, same length — the operator cycles through one tab
    expect(pane(ws, 'p1').tabs).toEqual(['kept', 'b'])
    expect(ws.previewTabId).toBe('b')
    expect(pane(ws, 'p1').active).toBe('b')
  })

  it('re-opening the preview tab is just an activate', () => {
    let ws = preview(preview(emptyWorkspace('k'), 'a'), 'b')
    ws = permanent(ws, 'kept')
    ws = preview(ws, 'b')
    expect(pane(ws, 'p1').tabs).toEqual(['b', 'kept'])
    expect(ws.previewTabId).toBe('b')
    expect(pane(ws, 'p1').active).toBe('b')
  })

  it('opening a tab that is already PERMANENT activates it and leaves the preview alone', () => {
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'temp')
    ws = preview(ws, 'kept')
    expect(ws.previewTabId).toBe('temp')
    expect(pane(ws, 'p1').tabs).toEqual(['kept', 'temp'])
    expect(pane(ws, 'p1').active).toBe('kept')
  })

  it('a permanent open of the preview promotes it in place — no reorder', () => {
    let ws = permanent(emptyWorkspace('k'), 'first')
    ws = preview(ws, 'temp')
    ws = permanent(ws, 'second')
    expect(pane(ws, 'p1').tabs).toEqual(['first', 'temp', 'second'])
    ws = permanent(ws, 'temp')
    expect(ws.previewTabId).toBeNull()
    expect(pane(ws, 'p1').tabs).toEqual(['first', 'temp', 'second'])
    expect(pane(ws, 'p1').active).toBe('temp')
  })

  it('appends and activates a permanent tab that was not open', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = permanent(ws, 'b')
    expect(pane(ws, 'p1').tabs).toEqual(['a', 'b'])
    expect(pane(ws, 'p1').active).toBe('b')
    expect(ws.previewTabId).toBeNull()
  })

  it('keeps at most one preview across panes: the older one becomes permanent', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = permanent(ws, 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    ws = step(ws, (w) => openTab(w, 'left', { permanent: false, paneId: 'p1' }))
    expect(ws.previewTabId).toBe('left')
    ws = step(ws, (w) => openTab(w, 'right', { permanent: false, paneId: 'p2' }))
    expect(ws.previewTabId).toBe('right')
    // 'left' is still open — it stopped being temporary, it was not closed.
    expect(pane(ws, 'p1').tabs).toContain('left')
    expect(pane(ws, 'p2').tabs).toEqual(['b', 'right'])
  })

  it('is a no-op for an empty id or an unknown pane', () => {
    const ws = permanent(emptyWorkspace('k'), 'a')
    expect(openTab(ws, '', { permanent: true })).toBe(ws)
    expect(openTab(ws, 'x', { permanent: true, paneId: 'nope' })).toBe(ws)
  })
})

describe('promoteTab / activateTab / focusPane', () => {
  it('promotes only the preview, and never reorders', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = preview(ws, 'b')
    ws = permanent(ws, 'c')
    const before = pane(ws, 'p1').tabs
    ws = step(ws, (w) => promoteTab(w, 'b'))
    expect(ws.previewTabId).toBeNull()
    expect(pane(ws, 'p1').tabs).toEqual(before)
    expect(promoteTab(ws, 'a')).toBe(ws)
    expect(promoteTab(ws, 'unknown')).toBe(ws)
  })

  it('activating a tab moves focus to its pane; an unknown tab is inert', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'column', { tabId: 'b' }))
    expect(ws.focusedPaneId).toBe('p2')
    ws = step(ws, (w) => activateTab(w, 'a'))
    expect(ws.focusedPaneId).toBe('p1')
    expect(activateTab(ws, 'ghost')).toBe(ws)
    expect(focusPane(ws, 'ghost')).toBe(ws)
    ws = step(ws, (w) => focusPane(w, 'p2'))
    expect(ws.focusedPaneId).toBe('p2')
  })
})

describe('closeTab', () => {
  it('hands over to the neighbour on the right, else the left', () => {
    let ws = permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'b'), 'c')
    ws = step(ws, (w) => activateTab(w, 'b'))
    ws = step(ws, (w) => closeTab(w, 'b'))
    expect(pane(ws, 'p1').tabs).toEqual(['a', 'c'])
    expect(pane(ws, 'p1').active).toBe('c')
    ws = step(ws, (w) => closeTab(w, 'c'))
    expect(pane(ws, 'p1').active).toBe('a')
  })

  it('closing an inactive tab leaves the active one alone', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => closeTab(w, 'a'))
    expect(pane(ws, 'p1').active).toBe('b')
  })

  it('clears the preview when the preview is the tab being closed', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = preview(ws, 'temp')
    ws = step(ws, (w) => closeTab(w, 'temp'))
    expect(ws.previewTabId).toBeNull()
    expect(allTabIds(ws)).toEqual(['a'])
  })

  it('the last tab of the LAST pane leaves a valid empty workspace', () => {
    let ws = preview(emptyWorkspace('k'), 'only')
    ws = step(ws, (w) => closeTab(w, 'only'))
    expect(allTabIds(ws)).toEqual([])
    expect(ws.previewTabId).toBeNull()
    expect(leafPaneIds(ws.root)).toHaveLength(1)
    expect(closeTab(ws, 'only')).toBe(ws)
  })

  it('an emptied NON-last pane collapses and focus lands on a live pane', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    expect(leafPaneIds(ws.root)).toEqual(['p1', 'p2'])
    ws = step(ws, (w) => closeTab(w, 'b'))
    expect(leafPaneIds(ws.root)).toEqual(['p1'])
    expect(ws.focusedPaneId).toBe('p1')
    expect(ws.panes.p2).toBeUndefined()
  })
})

describe('moveTab', () => {
  it('reorders within a pane and clamps the index', () => {
    let ws = permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'b'), 'c')
    ws = step(ws, (w) => moveTab(w, 'c', 'p1', 0))
    expect(pane(ws, 'p1').tabs).toEqual(['c', 'a', 'b'])
    ws = step(ws, (w) => moveTab(w, 'c', 'p1', 99))
    expect(pane(ws, 'p1').tabs).toEqual(['a', 'b', 'c'])
    ws = step(ws, (w) => moveTab(w, 'c', 'p1', -5))
    expect(pane(ws, 'p1').tabs).toEqual(['c', 'a', 'b'])
  })

  it('moves a tab across panes, activating it where it lands', () => {
    let ws = permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'b'), 'c')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'c' }))
    ws = step(ws, (w) => moveTab(w, 'a', 'p2', 0))
    expect(pane(ws, 'p1').tabs).toEqual(['b'])
    expect(pane(ws, 'p2').tabs).toEqual(['a', 'c'])
    expect(pane(ws, 'p2').active).toBe('a')
    expect(ws.focusedPaneId).toBe('p2')
  })

  it('collapses a pane whose last tab is dragged away', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    ws = step(ws, (w) => moveTab(w, 'b', 'p1', 0))
    expect(leafPaneIds(ws.root)).toEqual(['p1'])
    expect(pane(ws, 'p1').tabs).toEqual(['b', 'a'])
  })

  it('is inert for an unknown tab, an unknown pane or a nonsense index', () => {
    const ws = permanent(emptyWorkspace('k'), 'a')
    expect(moveTab(ws, 'ghost', 'p1', 0)).toBe(ws)
    expect(moveTab(ws, 'a', 'p9', 0)).toBe(ws)
    expect(moveTab(ws, 'a', 'p1', Number.NaN)).toBe(ws)
  })
})

describe('splitPane / closePane / resizeSplit', () => {
  it('moves the named tab into the new pane and focuses it', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    expect(ws.root).toMatchObject({ kind: 'split', axis: 'row', sizes: [0.5, 0.5] })
    expect(pane(ws, 'p1')).toEqual({ tabs: ['a'], active: 'a' })
    expect(pane(ws, 'p2')).toEqual({ tabs: ['b'], active: 'b' })
    expect(ws.focusedPaneId).toBe('p2')
  })

  it('opens a not-yet-open tab directly into the new pane', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = step(ws, (w) => splitPane(w, 'p1', 'column', { tabId: 'fresh' }))
    expect(pane(ws, 'p1')).toEqual({ tabs: ['a'], active: 'a' })
    expect(pane(ws, 'p2')).toEqual({ tabs: ['fresh'], active: 'fresh' })
  })

  it('without a tab it moves the active one — but never the pane’s only tab', () => {
    let single = permanent(emptyWorkspace('k'), 'a')
    single = step(single, (w) => splitPane(w, 'p1', 'row'))
    expect(pane(single, 'p1').tabs).toEqual(['a'])
    expect(pane(single, 'p2').tabs).toEqual([])

    let many = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    many = step(many, (w) => splitPane(w, 'p1', 'row'))
    expect(pane(many, 'p1').tabs).toEqual(['a'])
    expect(pane(many, 'p2').tabs).toEqual(['b'])
  })

  it('nests deeper splits and keeps pane ids unique', () => {
    let ws = permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'b'), 'c')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    ws = step(ws, (w) => splitPane(w, 'p2', 'column', { tabId: 'c' }))
    expect(leafPaneIds(ws.root)).toEqual(['p1', 'p2', 'p3'])
  })

  it('closePane migrates tabs to the previous leaf and refuses the last pane', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    ws = step(ws, (w) => closePane(w, 'p2'))
    expect(pane(ws, 'p1').tabs).toEqual(['a', 'b'])
    expect(ws.focusedPaneId).toBe('p1')
    expect(closePane(ws, 'p1')).toBe(ws)
    expect(closePane(ws, 'p9')).toBe(ws)
  })

  it('resizeSplit normalizes, and refuses a bad path or a bad size list', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    ws = step(ws, (w) => resizeSplit(w, [], [3, 1]))
    expect(ws.root).toMatchObject({ sizes: [0.75, 0.25] })
    expect(resizeSplit(ws, [0], [1, 1])).toBe(ws)
    expect(resizeSplit(ws, [], [1])).toBe(ws)
    expect(resizeSplit(ws, [], [1, 0])).toBe(ws)
    expect(resizeSplit(ws, [], [Number.NaN, 1])).toBe(ws)
  })
})

describe('pruneWorkspace', () => {
  it('drops tabs whose session is gone and repairs the actives', () => {
    let ws = permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'dead'), 'c')
    ws = step(ws, (w) => activateTab(w, 'dead'))
    ws = step(ws, (w) => pruneWorkspace(w, new Set(['a', 'c'])))
    expect(pane(ws, 'p1').tabs).toEqual(['a', 'c'])
    expect(pane(ws, 'p1').active).toBe('c')
  })

  it('clears the preview when the preview was pruned', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = preview(ws, 'dead')
    ws = step(ws, (w) => pruneWorkspace(w, new Set(['a'])))
    expect(ws.previewTabId).toBeNull()
  })

  it('returns the same layout when nothing is stale, and empties without losing panes', () => {
    const ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    expect(pruneWorkspace(ws, new Set(['a', 'b']))).toBe(ws)
    const emptied = step(ws, (w) => pruneWorkspace(w, new Set<string>()))
    expect(allTabIds(emptied)).toEqual([])
    expect(leafPaneIds(emptied.root)).toEqual(['p1'])
  })
})

describe('serialization', () => {
  it('round-trips a split workspace exactly', () => {
    let ws = permanent(permanent(emptyWorkspace('mission:m1'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'column', { tabId: 'b' }))
    ws = preview(ws, 'temp')
    const back = deserializeWorkspaces(serializeWorkspaces({ 'mission:m1': ws }))
    expect(back['mission:m1']).toEqual(ws)
  })

  it('is TOTAL over malformed, truncated and older-shaped input', () => {
    expect(deserializeWorkspaces(null)).toEqual({})
    expect(deserializeWorkspaces('')).toEqual({})
    expect(deserializeWorkspaces('{"v":1,"workspaces"')).toEqual({})
    expect(deserializeWorkspaces('[]')).toEqual({})
    expect(deserializeWorkspaces('{"v":0,"workspaces":{}}')).toEqual({})
    expect(deserializeWorkspaces('{"v":99,"workspaces":{}}')).toEqual({})
    // The pre-POD-710 shape (a bare tabOrders-style map) is not a workspace blob.
    expect(deserializeWorkspaces('{"issue:1":["s1","s2"]}')).toEqual({})
    expect(deserializeWorkspaces('{"v":1,"workspaces":{"k":{"panes":{}}}}')).toEqual({})
  })

  it('repairs a layout rather than trusting it', () => {
    const raw = JSON.stringify({
      v: 1,
      workspaces: {
        k: {
          key: 'stale-key',
          panes: {
            p1: { id: 'p1', tabs: ['a', 'dup', 7], activeTabId: 'ghost' },
            p2: { id: 'p2', tabs: ['dup', 'b'], activeTabId: 'b' },
            orphan: { id: 'orphan', tabs: ['x'], activeTabId: 'x' },
          },
          root: {
            kind: 'split',
            axis: 'row',
            children: [
              { kind: 'leaf', paneId: 'p1' },
              { kind: 'leaf', paneId: 'p2' },
            ],
            sizes: [2, 2],
          },
          focusedPaneId: 'gone',
          previewTabId: 'never-opened',
        },
      },
    })
    const ws = deserializeWorkspaces(raw).k as WorkspaceLayout
    expectInvariants(ws)
    expect(ws.key, 'the record key is the identity, not the stored one').toBe('k')
    expect(ws.panes.p1?.tabs).toEqual(['a', 'dup'])
    expect(ws.panes.p2?.tabs, 'a duplicated tab keeps its first pane only').toEqual(['b'])
    expect(ws.panes.orphan, 'a pane no leaf points at is dropped').toBeUndefined()
    expect(ws.panes.p1?.activeTabId, 'a dangling active falls back to the first tab').toBe('a')
    expect(ws.focusedPaneId).toBe('p1')
    expect(ws.previewTabId).toBeNull()
    expect(ws.root).toMatchObject({ sizes: [0.5, 0.5] })
  })

  it('drops only the unusable workspace, never its siblings', () => {
    const good = permanent(emptyWorkspace('issue:2'), 'a')
    const raw = JSON.stringify({
      v: 1,
      workspaces: { 'issue:1': { panes: { p1: {} }, root: { kind: 'leaf' } }, 'issue:2': good },
    })
    expect(Object.keys(deserializeWorkspaces(raw))).toEqual(['issue:2'])
  })

  it('collapses a split that lost all but one usable child', () => {
    const raw = JSON.stringify({
      v: 1,
      workspaces: {
        k: {
          panes: { p1: { id: 'p1', tabs: ['a'], activeTabId: 'a' } },
          root: {
            kind: 'split',
            axis: 'row',
            children: [
              { kind: 'leaf', paneId: 'p1' },
              { kind: 'leaf', paneId: 'vanished' },
            ],
            sizes: [0.5, 0.5],
          },
          focusedPaneId: 'p1',
          previewTabId: null,
        },
      },
    })
    const ws = deserializeWorkspaces(raw).k as WorkspaceLayout
    expectInvariants(ws)
    expect(ws.root).toEqual({ kind: 'leaf', paneId: 'p1' })
  })
})

describe('a whole session of edits keeps the layout valid', () => {
  it('survives an open/split/move/close sequence', () => {
    let ws = emptyWorkspace('mission:m1')
    ws = preview(ws, 's1')
    ws = preview(ws, 's2')
    ws = permanent(ws, 's2')
    ws = preview(ws, 's3')
    ws = step(ws, (w) => splitPane(w, w.focusedPaneId, 'row', { tabId: 's2' }))
    ws = permanent(ws, 's4')
    ws = step(ws, (w) => moveTab(w, 's4', 'p1', 0))
    ws = step(ws, (w) => closeTab(w, 's3'))
    ws = step(ws, (w) => closePane(w, 'p2'))
    expect(leafPaneIds(ws.root)).toEqual(['p1'])
    expect(paneOfTab(ws, 's2')?.id).toBe('p1')
    ws = step(ws, (w) => closeTab(w, 's4'))
    ws = step(ws, (w) => closeTab(w, 's2'))
    expect(allTabIds(ws)).toEqual([])
  })
})
