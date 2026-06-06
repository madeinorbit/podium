import { ChevronLeft, GitBranch, Globe } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import type { RepoCandidate } from './ranking'

export function RepoScanResults({
  scannedPath,
  candidates,
  adding,
  error,
  onAdd,
  onBack,
}: {
  scannedPath: string
  candidates: RepoCandidate[]
  adding: boolean
  error: string | null
  onAdd: (paths: string[]) => void
  onBack: () => void
}): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.filter((c) => c.defaultSelected).map((c) => c.path)),
  )

  const visible = useMemo(() => candidates.filter((c) => !c.hidden), [candidates])
  const hidden = useMemo(() => candidates.filter((c) => c.hidden), [candidates])

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function setGroup(group: RepoCandidate[], on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of group) {
        if (on) next.add(c.path)
        else next.delete(c.path)
      }
      return next
    })
  }

  const selectedCount = selected.size

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="repo-picker-modal" role="dialog" aria-modal="true" aria-label="Found repos">
        <div className="repo-picker-head">
          <div>
            <div className="label">FIND REPOSITORIES</div>
            <div className="repo-picker-path">{scannedPath}</div>
            <div className="scan-summary">
              {candidates.length} found · {selectedCount} selected
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onBack}
            aria-label="Back to browser"
          >
            <ChevronLeft size={16} />
          </button>
        </div>

        {error && <div className="repo-picker-error">{error}</div>}

        <div className="repo-picker-list scan-results">
          {candidates.length === 0 && (
            <div className="empty">No git repositories found in this folder.</div>
          )}
          {visible.length > 0 && (
            <Section
              title="PROJECTS"
              group={visible}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(visible, on)}
            />
          )}
          {hidden.length > 0 && (
            <Section
              title="HIDDEN / SYSTEM"
              group={hidden}
              selected={selected}
              onToggle={toggle}
              onAll={(on) => setGroup(hidden, on)}
            />
          )}
        </div>

        <div className="scan-footer">
          <button
            type="button"
            className="repo-picker-secondary"
            onClick={onBack}
            disabled={adding}
          >
            Back
          </button>
          <button
            type="button"
            className="repo-picker-add"
            disabled={adding || selectedCount === 0}
            onClick={() => onAdd([...selected])}
          >
            {adding ? 'Adding...' : `Add ${selectedCount} repo${selectedCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  group,
  selected,
  onToggle,
  onAll,
}: {
  title: string
  group: RepoCandidate[]
  selected: Set<string>
  onToggle: (path: string) => void
  onAll: (on: boolean) => void
}): JSX.Element {
  const allOn = group.every((c) => selected.has(c.path))
  return (
    <div className="scan-section">
      <div className="scan-section-head">
        <span className="label">{title}</span>
        <button type="button" className="scan-select-all" onClick={() => onAll(!allOn)}>
          {allOn ? 'none' : 'all'}
        </button>
      </div>
      {group.map((c) => (
        <label key={c.path} className="scan-row">
          <input type="checkbox" checked={selected.has(c.path)} onChange={() => onToggle(c.path)} />
          <span className="scan-row-name">{c.name}</span>
          <span className="scan-row-path">{c.path}</span>
          <span className="scan-row-meta">
            {c.branch && (
              <span className="scan-badge" title="branch">
                <GitBranch size={11} /> {c.branch}
              </span>
            )}
            {c.hasOrigin && (
              <span className="scan-badge" title="has remote">
                <Globe size={11} /> origin
              </span>
            )}
            {c.worktreeCount > 0 && <span className="scan-badge">+{c.worktreeCount} wt</span>}
          </span>
        </label>
      ))}
    </div>
  )
}
