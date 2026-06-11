import type { SessionMeta } from '@podium/protocol'
import { Pin } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { reposToViews, sessionsForWorktree, sortSessionsForPins } from './derive'
import { NewPanelMenu } from './NewPanelMenu'
import { useStore } from './store'
import type { WorktreeView } from './types'
import { WorkerLabel } from './WorkerLabel'

export function Workspace(): JSX.Element {
  const store = useStore()
  const {
    sessions,
    pins,
    setPinned,
    selectedWorktree,
    paneA,
    paneB,
    setPane,
    split,
    toggleSplit,
    killSession,
  } = store
  const [menuOpen, setMenuOpen] = useState(false)

  const worktree: WorktreeView | undefined = reposToViews(store.repos)
    .flatMap((r) => r.worktrees)
    .find((w) => w.path === selectedWorktree)

  const tabs = worktree
    ? sortSessionsForPins(sessionsForWorktree(sessions, worktree.path), pins)
    : []

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
              <span className={`dot ${t.status}`} /> <WorkerLabel session={t} />
            </button>
            <button
              type="button"
              className={pins.panels.includes(t.sessionId) ? 'tab-pin active' : 'tab-pin'}
              aria-pressed={pins.panels.includes(t.sessionId)}
              title={pins.panels.includes(t.sessionId) ? 'Unpin panel' : 'Pin panel'}
              onClick={() =>
                void setPinned('panel', t.sessionId, !pins.panels.includes(t.sessionId))
              }
            >
              <Pin size={12} aria-hidden="true" />
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
  tabs: SessionMeta[]
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="pane-picker">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <button key={t.sessionId} type="button" onClick={() => onPick(t.sessionId)}>
          <WorkerLabel session={t} />
        </button>
      ))}
    </div>
  )
}
