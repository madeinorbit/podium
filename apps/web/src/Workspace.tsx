import type { AgentKind } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { panelLabel, reposToViews, sessionsForWorktree } from './derive'
import { NewPanelMenu } from './NewPanelMenu'
import { useStore } from './store'
import type { WorktreeView } from './types'

export function Workspace(): JSX.Element {
  const store = useStore()
  const { sessions, selectedWorktree, paneA, paneB, setPane, split, toggleSplit, killSession } =
    store
  const [menuOpen, setMenuOpen] = useState(false)

  const worktree: WorktreeView | undefined = reposToViews(store.repos)
    .flatMap((r) => r.worktrees)
    .find((w) => w.path === selectedWorktree)

  const tabs = worktree ? sessionsForWorktree(sessions, worktree.path) : []

  // Keep pane A pointed at a valid tab.
  useEffect(() => {
    if (paneA && tabs.some((t) => t.sessionId === paneA)) return
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane])

  if (!worktree) return <div className="workspace empty">Select a worktree.</div>

  return (
    <section className="workspace">
      <div className="tabbar">
        {tabs.map((t) => (
          <span key={t.sessionId} className="tab-wrap">
            <button
              type="button"
              className={t.sessionId === paneA ? 'tab active' : 'tab'}
              onClick={() => setPane('A', t.sessionId)}
            >
              <span className={`dot ${t.status}`} /> {panelLabel(t.agentKind)}
            </button>
            <button
              type="button"
              className="tab-kill"
              title="Kill session"
              onClick={() => void killSession(t.sessionId)}
            >
              ✕
            </button>
          </span>
        ))}
        <button type="button" className="tab-add" onClick={() => setMenuOpen((v) => !v)}>
          +
        </button>
        <button type="button" className="tab-split" onClick={toggleSplit}>
          ⊟ split
        </button>
      </div>
      {menuOpen && (
        <div className="workspace-menu-layer">
          <NewPanelMenu
            worktree={worktree}
            onOpened={(sid) => {
              setPane('A', sid)
              setMenuOpen(false)
            }}
          />
        </div>
      )}
      <div className={split ? 'panes split' : 'panes'}>
        <div className="pane">{paneA ? <AgentPanel sessionId={paneA} /> : <Empty />}</div>
        {split && (
          <div className="pane">
            {paneB ? (
              <AgentPanel sessionId={paneB} />
            ) : (
              <PanePicker tabs={tabs} onPick={(id) => setPane('B', id)} />
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function Empty(): JSX.Element {
  return <div className="pane-empty">No panel — use + to start one.</div>
}

function PanePicker({
  tabs,
  onPick,
}: {
  tabs: { sessionId: string; agentKind: AgentKind }[]
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="pane-picker">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <button key={t.sessionId} type="button" onClick={() => onPick(t.sessionId)}>
          {panelLabel(t.agentKind)}
        </button>
      ))}
    </div>
  )
}
