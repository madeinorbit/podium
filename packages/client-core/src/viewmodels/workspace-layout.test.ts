import { asIssueId } from '@podium/model'
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
    expect(
      workspaceKeyFor({ missionRootId: asIssueId('iss_root'), issueId: asIssueId('iss_child') }),
    ).toBe('mission:iss_root')
    expect(workspaceKeyFor({ issueId: asIssueId('iss_child'), worktreePath: '/wt' })).toBe(
      'issue:iss_child',
    )
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
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'a')
    ws = preview(ws, 'b')
    ws = preview(ws, 'b')
    expect(pane(ws, 'p1').tabs).toEqual(['kept', 'b'])
    expect(ws.previewTabId).toBe('b')
    expect(pane(ws, 'p1').active).toBe('b')
  })

  // The temporary tab is held only while it is in front of you: landing on the
  // kept tab is walking away from the glance, so the glance closes.
  it('opening a tab that is already PERMANENT activates it and retires the preview', () => {
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'temp')
    ws = preview(ws, 'kept')
    expect(ws.previewTabId).toBeNull()
    expect(pane(ws, 'p1').tabs).toEqual(['kept'])
    expect(pane(ws, 'p1').active).toBe('kept')
  })

  it('a permanent open of a NEW tab retires the preview it lands beside', () => {
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'temp')
    ws = permanent(ws, 'fresh')
    expect(pane(ws, 'p1').tabs).toEqual(['kept', 'fresh'])
    expect(ws.previewTabId).toBeNull()
    expect(pane(ws, 'p1').active).toBe('fresh')
  })

  it('retires a preview that was the pane’s only tab', () => {
    let ws = preview(emptyWorkspace('k'), 'temp')
    ws = permanent(ws, 'kept')
    expect(pane(ws, 'p1').tabs).toEqual(['kept'])
    expect(ws.previewTabId).toBeNull()
  })

  it('a permanent open of the preview promotes it in place — no reorder', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'first'), 'second')
    ws = preview(ws, 'temp')
    // A drag is arrangement, not navigation: it moves the temporary tab into
    // the middle of the strip and leaves it temporary.
    ws = step(ws, (w) => moveTab(w, 'temp', 'p1', 1))
    expect(pane(ws, 'p1').tabs).toEqual(['first', 'temp', 'second'])
    expect(ws.previewTabId).toBe('temp')
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

  it('keeps at most one preview across panes: the older one is retired', () => {
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = permanent(ws, 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' }))
    ws = step(ws, (w) => openTab(w, 'left', { permanent: false, paneId: 'p1' }))
    expect(ws.previewTabId).toBe('left')
    ws = step(ws, (w) => openTab(w, 'right', { permanent: false, paneId: 'p2' }))
    expect(ws.previewTabId).toBe('right')
    // Previewing in the other pane is walking away from 'left': it goes rather
    // than staying behind as a tab nobody asked to keep.
    expect(pane(ws, 'p1').tabs).toEqual(['a'])
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

  // POD-740: the strip used to keep an italic tab you had walked away from —
  // marked temporary, behaving permanent.
  it('switching to another tab retires an unpromoted preview', () => {
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'temp')
    ws = step(ws, (w) => activateTab(w, 'kept'))
    expect(allTabIds(ws)).toEqual(['kept'])
    expect(ws.previewTabId).toBeNull()
    expect(pane(ws, 'p1').active).toBe('kept')
  })

  it('a promoted preview survives the switch', () => {
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'temp')
    ws = step(ws, (w) => promoteTab(w, 'temp')) // the operator typed into it
    ws = step(ws, (w) => activateTab(w, 'kept'))
    expect(allTabIds(ws)).toEqual(['kept', 'temp'])
  })

  it('activating the preview itself keeps it', () => {
    let ws = permanent(emptyWorkspace('k'), 'kept')
    ws = preview(ws, 'temp')
    ws = step(ws, (w) => activateTab(w, 'temp'))
    expect(allTabIds(ws)).toEqual(['kept', 'temp'])
    expect(ws.previewTabId).toBe('temp')
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

  it('splitting a single-tab pane by that tab opens the new pane EMPTY', () => {
    // "Split Right" on your only tab used to move it right and leave you looking
    // at an empty half where your work had been. The strip always passes
    // `{ tabId }`, so this is the common path, not a corner.
    let ws = permanent(emptyWorkspace('k'), 'a')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'a' }))
    expect(pane(ws, 'p1')).toEqual({ tabs: ['a'], active: 'a' })
    expect(pane(ws, 'p2')).toEqual({ tabs: [], active: null })
    expect(ws.focusedPaneId, 'the new pane still takes focus').toBe('p2')
  })

  it('a tab dragged out of ANOTHER pane leaves, and collapses the pane it emptied', () => {
    let ws = permanent(permanent(emptyWorkspace('k'), 'a'), 'b')
    ws = step(ws, (w) => splitPane(w, 'p1', 'row', { tabId: 'b' })) // p1:[a] p2:[b]
    ws = step(ws, (w) => splitPane(w, 'p1', 'column', { tabId: 'b' }))
    expect(leafPaneIds(ws.root), 'p2 emptied, so it goes').toEqual(['p1', 'p3'])
    expect(pane(ws, 'p1')).toEqual({ tabs: ['a'], active: 'a' })
    expect(pane(ws, 'p3')).toEqual({ tabs: ['b'], active: 'b' })
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

  it('picks a successor from the SURVIVING strip when several tabs are pruned', () => {
    // The off-by-one: `c`'s index in the original strip is 2, but only one tab
    // survives, so looking the successor up at 2 fell off the end and left a
    // non-empty pane with no active tab at all.
    let ws = permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'b'), 'c')
    ws = step(ws, (w) => pruneWorkspace(w, new Set(['a'])))
    expect(pane(ws, 'p1')).toEqual({ tabs: ['a'], active: 'a' })

    // …and the neighbour rule still holds when the survivors are on both sides.
    let wide = permanent(permanent(permanent(permanent(emptyWorkspace('k'), 'a'), 'b'), 'c'), 'd')
    wide = step(wide, (w) => activateTab(w, 'c'))
    wide = step(wide, (w) => pruneWorkspace(w, new Set(['a', 'd'])))
    expect(pane(wide, 'p1'), 'neighbour-right first').toEqual({ tabs: ['a', 'd'], active: 'd' })
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

  it('rejects a duplicated leaf rather than emptying the pane it names', () => {
    // The same pane named twice used to build it twice and keep the SECOND
    // pass, which saw every tab already claimed — so a corrupt tree deleted
    // real tabs. The duplicate leaf is what is unusable, not the pane.
    const raw = JSON.stringify({
      v: 1,
      workspaces: {
        k: {
          panes: { p1: { id: 'p1', tabs: ['a', 'b'], activeTabId: 'b' } },
          root: {
            kind: 'split',
            axis: 'row',
            children: [
              { kind: 'leaf', paneId: 'p1' },
              { kind: 'leaf', paneId: 'p1' },
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
    expect(pane(ws, 'p1')).toEqual({ tabs: ['a', 'b'], active: 'b' })
  })

  it('refuses `__proto__` as a pane id', () => {
    const raw = `{"v":1,"workspaces":{"k":{"panes":{"__proto__":{"id":"__proto__","tabs":["a"],"activeTabId":"a"},"p1":{"id":"p1","tabs":["b"],"activeTabId":"b"}},"root":{"kind":"split","axis":"row","children":[{"kind":"leaf","paneId":"__proto__"},{"kind":"leaf","paneId":"p1"}],"sizes":[0.5,0.5]},"focusedPaneId":"p1","previewTabId":null}}}`
    const ws = deserializeWorkspaces(raw).k as WorkspaceLayout
    expectInvariants(ws)
    expect(leafPaneIds(ws.root)).toEqual(['p1'])
    expect(Object.keys(ws.panes)).toEqual(['p1'])
    expect(Object.getPrototypeOf(ws.panes), 'the pane map kept its prototype').toBe(
      Object.prototype,
    )
    expect(
      ({} as Record<string, unknown>).tabs,
      'nothing landed on Object.prototype',
    ).toBeUndefined()
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
    ws = permanent(ws, 's3') // kept, so the rest of the session still has it
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
