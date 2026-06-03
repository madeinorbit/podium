import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { reposToViews, sessionsForWorktree } from './derive'
import { NewPanelMenu } from './NewPanelMenu'
import { useStore } from './store'
import type { WorktreeView } from './types'

export function Workspace(): JSX.Element {
  const store = useStore()
  const { sessions, selectedWorktree, paneA, paneB, setPane, split, toggleSplit } = store
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
          <button
            key={t.sessionId}
            type="button"
            className={t.sessionId === paneA ? 'tab active' : 'tab'}
            onClick={() => setPane('A', t.sessionId)}
          >
            <span className={`dot ${t.status}`} /> {t.agentKind}
          </button>
        ))}
        <button type="button" className="tab-add" onClick={() => setMenuOpen((v) => !v)}>
          +
        </button>
        <button type="button" className="tab-split" onClick={toggleSplit}>
          ⊟ split
        </button>
        {menuOpen && (
          <NewPanelMenu
            worktree={worktree}
            onOpened={(sid) => {
              setPane('A', sid)
              setMenuOpen(false)
            }}
          />
        )}
      </div>
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
  tabs: { sessionId: string; agentKind: string }[]
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="pane-picker">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <button key={t.sessionId} type="button" onClick={() => onPick(t.sessionId)}>
          {t.agentKind}
        </button>
      ))}
    </div>
  )
}
