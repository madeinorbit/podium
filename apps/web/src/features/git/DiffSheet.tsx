import { DiffView } from './diff-view'
import { useStoreHandle } from '@podium/client-core/react'
import { DIFF_SHEET_WRAP_KEY } from '@podium/client-core/ui-state'
import { observer } from '@podium/client-graph/react'
import type { MachineId } from '@podium/model'
import { GitBranch, GitCommitHorizontal, RefreshCw, WrapText } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppSheet } from '@/app/AppSheet'
import type { Trpc } from '@/app/trpc'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { type DiffRow, splitPath } from './diff-model'
import { entryBadge, entryStatus, entryTone, type StatusEntry } from './git-panel'

/**
 * THE DIFF SHEET — reading the working tree at reading size.
 *
 * The dock's Git tab unfolded a file's diff INSIDE the dock: a 300px column
 * showing 40 columns of code in 10.5px type, in a `max-h-72` box, one file at a
 * time, with the list scrolling away as it opened. That is a place to see THAT
 * a file changed; it is not a place to read WHAT changed. So the dock keeps the
 * inventory — which files, on which axis — and reading moves to the sheet tier
 * the shell already owns for utilities you visit and leave (POD-365): a click
 * on a file opens the whole diff over the live shell, and Esc puts it back.
 *
 * WHAT THE SHEET ADDS BEYOND ROOM. Three things, all of them things the dock
 * could not afford:
 *  - A rail of every changed file, so moving between files is one click (or
 *    j/k) and never a close-and-reopen. Only the file being read is fetched —
 *    visited files stay cached, so going back has nothing to wait for — and a
 *    rail row shows its +/− counts once that file has been read.
 *  - Line numbers on both sides, from git's own hunk headers — the diff says
 *    WHERE, not just what.
 *  - Sticky hunk headers, so the enclosing function stays on screen while its
 *    body scrolls past.
 *
 * COLOR IS THE ROW, NOT THE TEXT. The dock coloured whole lines live-blue and
 * red; over 400 lines that reads as two coloured smears you have to decode
 * character by character. Here the tint carries the sign — the row's ground,
 * its number and its marker — and the code itself stays in ordinary ink, which
 * is the thing you are actually reading. Blue for added and red for removed is
 * the shell's own vocabulary (this theme has no green: POD-166 R10).
 */
export function DiffSheet({
  cwd,
  machineId,
  entries,
  branch,
  commit,
  initialPath,
  onClose,
  onRefresh,
  refreshing,
  sources,
}: {
  cwd: string
  machineId?: MachineId
  /** The working-tree inventory, in the dock's own order. */
  entries: StatusEntry[]
  branch?: string | null
  /**
   * The COMMIT these entries belong to [POD-1289], when the sheet was opened
   * from an unfolded log row instead of from the working tree. It answers both
   * halves of the difference: each file's diff is read out of this commit
   * rather than out of the worktree (where a landed change reads as no change
   * at all), and the title names the commit rather than the branch. History is
   * immutable, so the re-probe control stands down with it.
   */
  commit?: { sha: string; shortSha: string; subject: string } | undefined
  /** The file the click was on — the sheet opens reading it. */
  initialPath: string
  onClose: () => void
  /** Re-probe status; the sheet drops its diffs when the inventory changes. */
  onRefresh: () => void
  refreshing: boolean
  /**
   * Diffs the caller already holds, keyed by path — used instead of asking git.
   * The chat opens this sheet on a file a RUN touched, and the change it wants
   * shown is the one that run made, which the transcript recorded. Re-probing
   * the worktree would show what the file holds now: the wrong answer the
   * moment anything was committed or edited again. With sources given there is
   * no working tree in play, so the re-probe control does not render.
   */
  sources?: Record<string, string> | undefined
}): JSX.Element {
  const [selected, setSelected] = useState(initialPath)
  const [wrap, setWrap] = usePersistedUiState<boolean>(DIFF_SHEET_WRAP_KEY, readWrap, writeWrap)
  // The inventory can change under the sheet (refresh, or an agent committing
  // while you read): fall back to the first file rather than an empty pane.
  const entryIndex = useMemo(
    () => new Map(entries.map((entry, index) => [entry.path, index])),
    [entries],
  )
  const current = entries[entryIndex.get(selected) ?? 0]
  const diffs = useDiffs({ entries, entry: current, cwd, machineId, sources, commit })
  const railRef = useRef<HTMLElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  const move = useCallback(
    (delta: number) => {
      if (entries.length === 0) return
      const at = entryIndex.get(selected) ?? 0
      const next = entries[Math.min(entries.length - 1, Math.max(0, at + delta))]
      if (next) setSelected(next.path)
    },
    [entries, entryIndex, selected],
  )

  // j/k walk the files from anywhere in the sheet — the rail's own arrow keys
  // need it focused, and the reader's hands are usually on the diff. Arrow keys
  // are deliberately NOT bound globally: they scroll the diff, which is the
  // more common intent while reading one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      if (event.key !== 'j' && event.key !== 'k') return
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      event.preventDefault()
      move(event.key === 'j' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move])

  // The rail follows the selection, so walking the list with the keyboard never
  // leaves the current row off-screen — and the focus goes with it, unless the
  // reader is somewhere else entirely, in which case taking their focus would
  // be the rudest thing this sheet could do. (The pane is keyed by path and
  // remounts at its own top.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path IS the trigger — the body reads the ref that follows it.
  useEffect(() => {
    const row = selectedRef.current
    if (!row) return
    row.scrollIntoView?.({ block: 'nearest' })
    if (railRef.current?.contains(document.activeElement)) row.focus({ preventScroll: true })
  }, [current?.path])

  return (
    <AppSheet
      label={commit ? `Commit ${commit.shortSha}` : 'Working tree changes'}
      testId="diff-sheet"
      className="app-sheet-diff"
      title={
        // A commit already HAS a name — its subject — so the sheet wears that
        // instead of the generic word, with the sha where the branch chip sits.
        // The reader arrived here from one row of a log; the title has to say
        // which row, or every commit's diff looks like the same sheet.
        commit ? (
          <span className="diff-sheet-title">
            <span className="diff-sheet-subject" title={commit.subject}>
              {commit.subject}
            </span>
            <span className="diff-sheet-branch" title={commit.sha}>
              <GitCommitHorizontal size={11} aria-hidden="true" />
              <bdi>{commit.shortSha}</bdi>
            </span>
          </span>
        ) : (
          <span className="diff-sheet-title">
            Changes
            {branch && (
              <span className="diff-sheet-branch" title={`on ${branch}`}>
                <GitBranch size={11} aria-hidden="true" />
                <bdi>{branch}</bdi>
              </span>
            )}
          </span>
        )
      }
      toolbar={
        <span className="diff-sheet-toolbar">
          {/* The totals land when every file has been visited: a figure that
              climbs while the reader visits files is a progress bar wearing a
              number's clothes. */}
          <DiffTotals cache={diffs} count={entries.length} committed={!!commit} />
          <button
            data-pressable
            type="button"
            className="diff-sheet-tool"
            aria-pressed={wrap}
            title={wrap ? 'Wrap long lines — on' : 'Wrap long lines — off'}
            onClick={() => {
              setWrap(!wrap)
            }}
          >
            <WrapText size={14} aria-hidden="true" />
          </button>
          {!sources && !commit && (
            <button
              data-pressable
              type="button"
              className="diff-sheet-tool"
              title="Re-read the working tree"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                size={14}
                className={refreshing ? 'animate-spin' : ''}
                aria-hidden="true"
              />
            </button>
          )}
        </span>
      }
      onClose={onClose}
    >
      <div className="diff-sheet">
        {/* The rail is the settings rail's grammar — a column of buttons, the
            current one marked — rather than a listbox widget: the destinations
            ARE links to a pane, Tab walks them, and the arrow keys move the
            selection AND the focus with it. */}
        <nav
          ref={railRef}
          aria-label="Changed files"
          className="diff-rail"
          onKeyDown={(event) => {
            const step =
              event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowUp'
                  ? -1
                  : event.key === 'Home'
                    ? -entries.length
                    : event.key === 'End'
                      ? entries.length
                      : 0
            if (step === 0) return
            event.preventDefault()
            move(step)
          }}
        >
          <div className="diff-rail-head">
            {entries.length} {entries.length === 1 ? 'file' : 'files'}
            <span className="diff-rail-hint">j / k</span>
          </div>
          {entries.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              cache={diffs}
              selected={entry.path === current?.path}
              rowRef={entry.path === current?.path ? selectedRef : undefined}
              onSelect={() => setSelected(entry.path)}
            />
          ))}
        </nav>
        <div className="diff-pane">
          {current ? (
            <FilePane key={current.path} entry={current} cache={diffs} wrap={wrap} />
          ) : (
            <div className="diff-empty">
              {commit ? 'This commit touched no files.' : 'Working tree clean.'}
            </div>
          )}
        </div>
      </div>
    </AppSheet>
  )
}

/** One rail row: axis badge, file name, its counts, and the folder it lives in. */
const FileRow = observer(function FileRow({
  entry,
  cache,
  selected,
  rowRef,
  onSelect,
}: {
  entry: StatusEntry
  cache: DiffCache
  selected: boolean
  rowRef?: React.RefObject<HTMLButtonElement | null>
  onSelect: () => void
}): JSX.Element {
  const parsed = cache.states.get(entry.path)?.parsed
  const { dir, name } = splitPath(entry.path)
  return (
    <button
      ref={rowRef}
      type="button"
      aria-current={selected}
      data-pressable
      data-path={entry.path}
      className="diff-file"
      title={`${entryStatus(entry)} — ${entry.path}`}
      onClick={onSelect}
    >
      <span className={`diff-file-badge diff-tone-${entryTone(entry)}`}>{entryBadge(entry)}</span>
      <span className="diff-file-name">{name}</span>
      {parsed && !parsed.binary && (
        <span className="diff-file-counts">
          {parsed.added > 0 && <span className="diff-count-add">+{parsed.added}</span>}
          {parsed.removed > 0 && <span className="diff-count-del">−{parsed.removed}</span>}
        </span>
      )}
      {dir !== '' && (
        <span className="diff-file-dir" dir="rtl">
          <bdi>{dir}</bdi>
        </span>
      )}
    </button>
  )
})

const DiffTotals = observer(function DiffTotals({
  cache,
  count,
  committed,
}: {
  cache: DiffCache
  count: number
  committed: boolean
}): JSX.Element | null {
  const totals = cache.totals
  if (count === 0 || totals.settled !== count) return null
  return (
    <span
      className="diff-sheet-totals"
      title={
        committed
          ? 'Lines added and removed by this commit'
          : 'Lines added and removed against HEAD'
      }
    >
      <span className="diff-count-add">+{totals.added}</span>
      <span className="diff-count-del">−{totals.removed}</span>
    </span>
  )
})

/** The reading half: what happened to this file, then the diff itself. */
const FilePane = observer(function FilePane({
  entry,
  cache,
  wrap,
}: {
  entry: StatusEntry
  cache: DiffCache
  wrap: boolean
}): JSX.Element {
  const state = cache.states.get(entry.path)
  const { dir, name } = splitPath(entry.path)
  const parsed = state?.parsed
  return (
    <>
      <header className="diff-head">
        <span className="diff-head-path">
          {dir !== '' && <span className="diff-head-dir">{dir}/</span>}
          <span className="diff-head-name">{name}</span>
        </span>
        <span className="diff-head-status">
          {entryStatus(entry)}
          {entry.renamedFrom && <span className="diff-head-from"> from {entry.renamedFrom}</span>}
        </span>
        {parsed && !parsed.binary && (
          <span className="diff-head-counts">
            <span className="diff-count-add">+{parsed.added}</span>
            <span className="diff-count-del">−{parsed.removed}</span>
          </span>
        )}
      </header>
      <div className="diff-scroll" data-wrap={wrap ? 'on' : 'off'}>
        {state?.note ? (
          <div className="diff-notice">{state.note}</div>
        ) : state?.error ? (
          <div className="diff-notice diff-notice-error">{state.error}</div>
        ) : !parsed ? (
          <DiffSkeleton />
        ) : parsed.binary ? (
          // Git's own line names both blobs; the reader only needs the fact.
          <div className="diff-notice">{BINARY_FILE}</div>
        ) : parsed.rows.length === 0 ? (
          <div className="diff-notice">
            {entry.untracked
              ? 'This file is empty.'
              : 'No textual change — only file mode or metadata differs.'}
          </div>
        ) : (
          <>
            <div className="diff-lines">
              {parsed.rows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a static parsed list
                <Row key={i} row={row} />
              ))}
            </div>
            {parsed.truncated > 0 && (
              <div className="diff-notice">
                {parsed.truncated.toLocaleString()} further lines are not shown — this diff is
                longer than the viewer renders.
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
})

function Row({ row }: { row: DiffRow }): JSX.Element {
  if (row.kind === 'hunk')
    return (
      <div className="diff-row diff-row-hunk">
        <span className="diff-hunk-inner">
          <span className="diff-hunk-span">{row.text}</span>
          {row.context && <span className="diff-hunk-context">{row.context}</span>}
        </span>
      </div>
    )
  if (row.kind === 'note')
    return (
      <div className="diff-row diff-row-note">
        <span className="diff-note-text">{row.text}</span>
      </div>
    )
  return (
    <div className={`diff-row diff-row-${row.kind}`}>
      <span className="diff-num">{row.oldNo ?? ''}</span>
      <span className="diff-num">{row.newNo ?? ''}</span>
      <span className="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
      <span className="diff-code">{row.text === '' ? ' ' : row.text}</span>
    </div>
  )
}

/**
 * Loading is a shape (POD-394): the diff arrives as lines, so the wait is drawn
 * as lines of the right rhythm rather than as a spinner in the middle of the
 * pane or a sentence where the code goes.
 */
function DiffSkeleton(): JSX.Element {
  return (
    <div className="diff-skeleton" aria-hidden="true">
      {SKELETON_WIDTHS.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative list
        <span key={i} className="diff-skeleton-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

const SKELETON_WIDTHS = [38, 62, 47, 71, 29, 55, 66, 41, 58, 34, 49, 63]

// ---------------------------------------------------------------------------
// the diff cache
// ---------------------------------------------------------------------------

type DiffCache = DiffView

/** The sheet owns one answer model per inventory/source identity. */
function useDiffs({
  entries,
  entry,
  cwd,
  machineId,
  sources,
  commit,
}: {
  entries: StatusEntry[]
  entry: StatusEntry | undefined
  cwd: string
  machineId?: MachineId
  sources?: Record<string, string>
  commit?: { sha: string }
}): DiffView {
  const { gitDiffFile, gitCommitDiffFile, readFileScoped } = useStoreHandle<Trpc>().access
  const commitSha = commit?.sha
  // biome-ignore lint/correctness/useExhaustiveDependencies: the inventory is part of this opening's identity.
  const view = useMemo(
    () =>
      new DiffView(
        cwd,
        machineId,
        { gitDiffFile, gitCommitDiffFile, readFileScoped },
        sources,
        commitSha,
      ),
    [entries, cwd, machineId, sources, commitSha, gitDiffFile, gitCommitDiffFile, readFileScoped],
  )
  useEffect(() => () => view.close(), [view])
  useEffect(() => {
    if (entry) void view.load(entry)
  }, [view, entry])
  return view
}

// ---------------------------------------------------------------------------

/** Wrapping is a reading preference, so it outlives the sheet that set it. It
 *  is device-local UI state with a declared home (POD-329), which is why it is
 *  read through the ui-state collection rather than a key of this file's own. */
const readWrap = (raw: string | null): boolean => raw === '1'
const writeWrap = (on: boolean): string => (on ? '1' : '0')
