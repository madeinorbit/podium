import { shallowEqual } from '@podium/client-core/shallow-equal'
import { artifactKind, artifactUrl, basename } from '@podium/client-core/values'
import { type IssuePanelArtifact, resolveMachinePath } from '@podium/model/browser'
import {
  Clapperboard,
  FileText,
  Image,
  LayoutGrid,
  List,
  Package,
  Play,
  Search,
  Table2,
} from 'lucide-react'
import { type JSX, useDeferredValue, useMemo, useState } from 'react'
import { useRuntimeSelector } from '@/app/store'
import { currentWorkspaceSlug } from '@/lib/workspace-request'
import {
  type ArtifactFilter,
  artifactFile,
  artifactLabel,
  artifactTypeLabel,
  indexArtifacts,
  shortDate,
  usePageIssue,
} from './artifacts-tab'

export { isArtifactsTab, openArtifactsTab, useOpenArtifactsTab } from './artifacts-tab'

/** Thumbnails drawn before "Show N more" — two rows of the four-column grid. */
const SCREEN_PAGE = 8
/** Rows drawn before "Show N more". Both lists are BOUNDED rather than
 *  virtualised: an issue with hundreds of artifacts mounts at most one page per
 *  click, and nothing below the fold loads an image it has not reached. */
const ROW_PAGE = 50

const FILTERS: { id: ArtifactFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'screen', label: 'Screens' },
  { id: 'document', label: 'Documents' },
  { id: 'report', label: 'Reports' },
]

const EMPTY: readonly IssuePanelArtifact[] = []

/**
 * THE ARTIFACTS TAB (design 5a): everything an issue has published, as a page.
 * Screens are a thumbnail grid; documents and reports are a quiet table. Filter
 * chips hide the groups the issue has none of and count what the search
 * matches; search narrows within the chip. Opening an item uses the same open path as the task
 * panel, so it lands in its own tab.
 */
export function ArtifactsTab({ issueId }: { issueId: string }): JSX.Element {
  const issue = usePageIssue(issueId)
  const { httpOrigin, openArtifact, openFileInWorktree } = useRuntimeSelector(
    (s) => ({
      httpOrigin: s.httpOrigin,
      openArtifact: s.openArtifact,
      openFileInWorktree: s.openFileInWorktree,
    }),
    shallowEqual,
  )
  const artifacts = issue?.panel?.artifacts ?? EMPTY
  const root = issue ? (issue.worktreePath ?? issue.repoPath) : undefined

  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [screenLimit, setScreenLimit] = useState(SCREEN_PAGE)
  const [rowLimit, setRowLimit] = useState(ROW_PAGE)
  // Typing stays on the input's frame; the list catches up on the next one.
  const deferredQuery = useDeferredValue(query)
  const index = useMemo(
    () => indexArtifacts(artifacts, filter, deferredQuery),
    [artifacts, filter, deferredQuery],
  )

  const open = (a: IssuePanelArtifact): void => {
    if (!issue) return
    // Same split as the task panel: snapshots open their stored bytes; legacy
    // path-only entries open the live file in the issue's checkout.
    if (a.artifactId) {
      openArtifact({
        issueId: issue.id,
        artifactId: a.artifactId,
        path: a.entry ?? basename(a.path),
        ...(root ? { worktreePath: root } : {}),
      })
    } else if (root) {
      openFileInWorktree({ root, path: resolveMachinePath(root, a.path), issueId: issue.id })
    }
  }
  const srcOf = (a: IssuePanelArtifact): string | null =>
    issue
      ? artifactUrl({
          httpOrigin,
          workspace: currentWorkspaceSlug(),
          issueId: issue.id,
          artifact: a,
          ...(root ? { root } : {}),
        })
      : null

  const chips = FILTERS.filter((f) => f.id === 'all' || index.totals[f.id] > 0)
  const shownScreens = index.screens.slice(0, view === 'grid' ? screenLimit : rowLimit)
  const shownRows = index.documents.slice(0, rowLimit)
  const docsTitle =
    filter === 'document' ? 'Documents' : filter === 'report' ? 'Reports' : 'Documents & reports'
  const nothing = index.screens.length === 0 && index.documents.length === 0

  return (
    <div className="artifacts-tab" data-testid="artifacts-tab">
      <div className="artifacts-tab-bar">
        <div className="flex items-center gap-2">
          {chips.map((f) => (
            <button
              key={f.id}
              data-pressable
              type="button"
              aria-pressed={filter === f.id}
              className="artifacts-chip"
              data-active={filter === f.id ? 'true' : undefined}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="artifacts-chip-count">{index.counts[f.id]}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label className="artifacts-search">
          <Search size={13} aria-hidden="true" className="flex-none" />
          <input
            type="search"
            value={query}
            placeholder="Search artifacts"
            aria-label="Search artifacts"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="artifacts-view-toggle">
          <button
            data-pressable
            type="button"
            aria-pressed={view === 'grid'}
            aria-label="Grid"
            title="Grid"
            data-active={view === 'grid' ? 'true' : undefined}
            onClick={() => setView('grid')}
          >
            <LayoutGrid size={13} aria-hidden="true" />
          </button>
          <button
            data-pressable
            type="button"
            aria-pressed={view === 'list'}
            aria-label="List"
            title="List"
            data-active={view === 'list' ? 'true' : undefined}
            onClick={() => setView('list')}
          >
            <List size={13} aria-hidden="true" />
          </button>
        </span>
      </div>

      {issue === undefined ? null : nothing ? (
        <p className="artifacts-empty">
          {artifacts.length === 0
            ? 'No artifacts yet. Screenshots, documents and reports an agent attaches to this task show up here.'
            : 'Nothing matches.'}
        </p>
      ) : null}

      {index.screens.length > 0 && (
        <section className="artifacts-section" aria-label="Screens">
          <h3 className="artifacts-section-title">
            Screens <span>{index.screens.length}</span>
          </h3>
          {view === 'grid' ? (
            <div className="artifacts-grid">
              {shownScreens.map((a) => (
                <ScreenCard
                  key={a.artifactId ?? a.path}
                  artifact={a}
                  src={srcOf(a)}
                  onOpen={open}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col">
              {shownScreens.map((a) => (
                <ArtifactRow key={a.artifactId ?? a.path} artifact={a} onOpen={open} />
              ))}
            </div>
          )}
          <ShowMore
            remaining={index.screens.length - shownScreens.length}
            page={view === 'grid' ? SCREEN_PAGE * 3 : ROW_PAGE}
            onMore={(n) =>
              view === 'grid' ? setScreenLimit((l) => l + n) : setRowLimit((l) => l + n)
            }
          />
        </section>
      )}

      {index.documents.length > 0 && (
        <section className="artifacts-section" aria-label={docsTitle}>
          <h3 className="artifacts-section-title">
            {docsTitle} <span>{index.documents.length}</span>
          </h3>
          <div className="flex flex-col">
            {shownRows.map((a) => (
              <ArtifactRow key={a.artifactId ?? a.path} artifact={a} onOpen={open} />
            ))}
          </div>
          <ShowMore
            remaining={index.documents.length - shownRows.length}
            page={ROW_PAGE}
            onMore={(n) => setRowLimit((l) => l + n)}
          />
        </section>
      )}
    </div>
  )
}

function ShowMore({
  remaining,
  page,
  onMore,
}: {
  remaining: number
  page: number
  onMore: (n: number) => void
}): JSX.Element | null {
  if (remaining <= 0) return null
  const n = Math.min(remaining, page)
  return (
    <button data-pressable type="button" className="artifacts-more" onClick={() => onMore(n)}>
      Show {n} more
    </button>
  )
}

function ScreenCard({
  artifact,
  src,
  onOpen,
}: {
  artifact: IssuePanelArtifact
  src: string | null
  onOpen: (a: IssuePanelArtifact) => void
}): JSX.Element {
  const label = artifactLabel(artifact)
  const video = artifactKind(artifactFile(artifact)) === 'video'
  return (
    <button
      data-pressable
      type="button"
      className="artifacts-card"
      title={label}
      onClick={() => onOpen(artifact)}
    >
      <span className="artifacts-thumb">
        {src ? (
          video ? (
            <>
              <video src={src} preload="metadata" muted tabIndex={-1} />
              <span className="artifacts-play">
                <Play size={14} aria-hidden="true" className="translate-x-px" />
              </span>
            </>
          ) : (
            <img src={src} alt="" loading="lazy" decoding="async" />
          )
        ) : (
          <span className="artifacts-thumb-missing">{basename(artifact.path)}</span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 text-left">
        <span className="artifacts-card-title">{label}</span>
        <span className="artifacts-meta" title={new Date(artifact.addedAt).toLocaleString()}>
          {artifactTypeLabel(artifact)} · {shortDate(artifact.addedAt)}
        </span>
      </span>
    </button>
  )
}

function RowIcon({ type }: { type: string }): JSX.Element {
  const Icon =
    type === 'Image'
      ? Image
      : type === 'Video'
        ? Clapperboard
        : type === 'Package'
          ? Package
          : type === 'Data'
            ? Table2
            : FileText
  return <Icon size={14} aria-hidden="true" className="flex-none text-text-faint" />
}

function ArtifactRow({
  artifact,
  onOpen,
}: {
  artifact: IssuePanelArtifact
  onOpen: (a: IssuePanelArtifact) => void
}): JSX.Element {
  const type = artifactTypeLabel(artifact)
  return (
    <button
      data-pressable
      type="button"
      className="artifacts-row"
      title={artifact.path}
      onClick={() => onOpen(artifact)}
    >
      <RowIcon type={type} />
      <span className="artifacts-row-name">{artifactLabel(artifact)}</span>
      <span className="artifacts-row-type">{type}</span>
      <span className="artifacts-row-date" title={new Date(artifact.addedAt).toLocaleString()}>
        {shortDate(artifact.addedAt)}
      </span>
    </button>
  )
}
