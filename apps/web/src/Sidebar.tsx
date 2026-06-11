import type { SessionMeta } from '@podium/protocol'
import { Pin } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { type RepoNavView, sidebarSections, type WorktreeNavView } from './derive'
import { HostIndicators } from './HostIndicators'
import { RepoScanFlow } from './RepoScanFlow'
import { useStore } from './store'
import type { PinKind } from './types'
import { WorkerLabel } from './WorkerLabel'

export function Sidebar(): JSX.Element {
  const {
    repos,
    reposLoading,
    repoDiagnostics,
    sessions,
    pins,
    setPinned,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    setPane,
  } = useStore()
  const sections = sidebarSections(repos, sessions, pins)
  const [pickerOpen, setPickerOpen] = useState(false)
  const hasRows =
    sections.pinnedPanels.length > 0 ||
    sections.pinnedWorktrees.length > 0 ||
    sections.pinnedRepos.length > 0 ||
    sections.repos.length > 0

  const selectPanel = (worktreePath: string, sessionId: string) => {
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="label">WORKTREES</span>
        <button type="button" onClick={() => setPickerOpen(true)}>
          + Add repo
        </button>
      </div>
      {(reposLoading || repoDiagnostics.length > 0) && (
        <div className="scan-status">
          {reposLoading
            ? 'Loading repositories...'
            : `Scan finished with ${repoDiagnostics.length} warning${repoDiagnostics.length === 1 ? '' : 's'}.`}
        </div>
      )}
      <div className="sidebar-list">
        {sections.pinnedPanels.length > 0 && (
          <PinnedSection label="PINNED PANELS">
            {sections.pinnedPanels.map((session) => (
              <PanelRow
                key={session.sessionId}
                session={session}
                pinned={true}
                active={selectedWorktree === session.cwd && paneA === session.sessionId}
                onSelect={() => selectPanel(session.cwd, session.sessionId)}
                onPinned={(pinned) => void setPinned('panel', session.sessionId, pinned)}
              />
            ))}
          </PinnedSection>
        )}

        {sections.pinnedWorktrees.length > 0 && (
          <PinnedSection label="PINNED WORKTREES">
            {sections.pinnedWorktrees.map((worktree) => (
              <WorktreeBlock
                key={worktree.path}
                worktree={worktree}
                pinned={true}
                active={selectedWorktree === worktree.path}
                paneA={paneA}
                setPinned={setPinned}
                onSelectWorktree={() => setSelectedWorktree(worktree.path)}
                onSelectPanel={selectPanel}
              />
            ))}
          </PinnedSection>
        )}

        {sections.pinnedRepos.length > 0 && (
          <PinnedSection label="PINNED REPOS">
            {sections.pinnedRepos.map((repo) => (
              <RepoBlock
                key={repo.path}
                repo={repo}
                pinned={true}
                selectedWorktree={selectedWorktree}
                paneA={paneA}
                setPinned={setPinned}
                onSelectWorktree={setSelectedWorktree}
                onSelectPanel={selectPanel}
              />
            ))}
          </PinnedSection>
        )}

        {sections.repos.map((repo) => (
          <RepoBlock
            key={repo.path}
            repo={repo}
            pinned={false}
            selectedWorktree={selectedWorktree}
            paneA={paneA}
            setPinned={setPinned}
            onSelectWorktree={setSelectedWorktree}
            onSelectPanel={selectPanel}
          />
        ))}

        {!hasRows && <div className="empty">No repos yet. Use "+ Add repo" to scan a folder.</div>}
      </div>
      {/* Host health strip, pinned under the list — machine-level indicators
          (connection health, memory). */}
      <HostIndicators />
      {pickerOpen && (
        <RepoScanFlow onClose={() => setPickerOpen(false)} onDone={() => setPickerOpen(false)} />
      )}
    </aside>
  )
}

function PinnedSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pinned-section">
      <div className="pin-section-label">{label}</div>
      {children}
    </div>
  )
}

function RepoBlock({
  repo,
  pinned,
  selectedWorktree,
  paneA,
  setPinned,
  onSelectWorktree,
  onSelectPanel,
}: {
  repo: RepoNavView
  pinned: boolean
  selectedWorktree: string | null
  paneA: string | null
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  onSelectWorktree: (path: string) => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
}): JSX.Element {
  return (
    <div className="repo">
      <div className="repo-head">
        <div className="repo-name">{repo.name}</div>
        <PinButton
          kind="repo"
          id={repo.path}
          pinned={pinned}
          label={repo.name}
          setPinned={setPinned}
        />
      </div>
      {repo.worktrees.map((worktree) => (
        <WorktreeBlock
          key={worktree.path}
          worktree={worktree}
          pinned={false}
          active={selectedWorktree === worktree.path}
          paneA={paneA}
          setPinned={setPinned}
          onSelectWorktree={() => onSelectWorktree(worktree.path)}
          onSelectPanel={onSelectPanel}
        />
      ))}
    </div>
  )
}

function WorktreeBlock({
  worktree,
  pinned,
  active,
  paneA,
  setPinned,
  onSelectWorktree,
  onSelectPanel,
}: {
  worktree: WorktreeNavView
  pinned: boolean
  active: boolean
  paneA: string | null
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  onSelectWorktree: () => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
}): JSX.Element {
  return (
    <div className="worktree-block">
      <div className="worktree-row-wrap">
        <button
          type="button"
          className={active ? 'worktree active' : 'worktree'}
          onClick={onSelectWorktree}
        >
          <span className="branch">{worktree.branch ?? worktree.path.split('/').pop()}</span>
          {pinned && <span className="worktree-context">{worktree.repoName}</span>}
          {worktree.isMain && <span className="tag">main</span>}
        </button>
        <PinButton
          kind="worktree"
          id={worktree.path}
          pinned={pinned}
          label={worktree.branch ?? worktree.path}
          setPinned={setPinned}
        />
      </div>
      {worktree.sessions.map((session) => {
        const panelActive = active && paneA === session.sessionId
        return (
          <PanelRow
            key={session.sessionId}
            session={session}
            pinned={false}
            active={panelActive}
            onSelect={() => onSelectPanel(worktree.path, session.sessionId)}
            onPinned={(pinned) => void setPinned('panel', session.sessionId, pinned)}
          />
        )
      })}
    </div>
  )
}

function PanelRow({
  session,
  pinned,
  active,
  onSelect,
  onPinned,
}: {
  session: SessionMeta
  pinned: boolean
  active: boolean
  onSelect: () => void
  onPinned: (pinned: boolean) => void
}): JSX.Element {
  return (
    <div className="panel-row-wrap">
      <button
        type="button"
        className={active ? 'panel-row active' : 'panel-row'}
        onClick={onSelect}
      >
        <span className={`dot ${session.status}`} /> <WorkerLabel session={session} />
      </button>
      <button
        type="button"
        className={pinned ? 'pin-button active' : 'pin-button'}
        aria-pressed={pinned}
        title={pinned ? 'Unpin panel' : 'Pin panel'}
        onClick={() => onPinned(!pinned)}
      >
        <Pin size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

function PinButton({
  kind,
  id,
  pinned,
  label,
  setPinned,
}: {
  kind: PinKind
  id: string
  pinned: boolean
  label: string
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
}): JSX.Element {
  const title = `${pinned ? 'Unpin' : 'Pin'} ${label}`
  return (
    <button
      type="button"
      className={pinned ? 'pin-button active' : 'pin-button'}
      aria-pressed={pinned}
      title={title}
      onClick={() => void setPinned(kind, id, !pinned)}
    >
      <Pin size={13} aria-hidden="true" />
    </button>
  )
}
