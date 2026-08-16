import type { MachineId } from '@podium/model'
import { shallowEqual } from '@podium/client-core/store'
import { GitBranch, RefreshCw, WrapText } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppSheet } from '@/app/AppSheet'
import { useStoreSelector } from '@/app/store'
import { type DiffRow, type ParsedDiff, parseDiff, splitPath } from './diff-model'
import { entryBadge, entryStatus, entryTone, type StatusEntry, untrackedDiff } from './git-panel'

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
 *  - A rail of every changed file with its own +/− counts, so moving between
 *    files is one click (or j/k) and never a close-and-reopen. Every file's
 *    diff is fetched in the background as you read the first one, so the second
 *    click has nothing to wait for.
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
  const [wrap, setWrap] = useState(readWrapPreference)
  const diffs = useDiffs({ entries, cwd, machineId, selected, sources })

  // The inventory can change under the sheet (refresh, or an agent committing
  // while you read): fall back to the first file rather than an empty pane.
  const current = entries.find((e) => e.path === selected) ?? entries[0]
  const railRef = useRef<HTMLElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  const move = useCallback(
    (delta: number) => {
      if (entries.length === 0) return
      const at = entries.findIndex((e) => e.path === current?.path)
      const next = entries[Math.min(entries.length - 1, Math.max(0, at + delta))]
      if (next) setSelected(next.path)
    },
    [entries, current],
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

  const totals = useMemo(() => {
    let added = 0
    let removed = 0
    let pending = 0
    for (const e of entries) {
      const state = diffs[e.path]
      // Pending means UNRESOLVED, not "has no diff": a binary blob and an
      // untracked folder are answers, and totals that waited for lines from
      // them would never appear in a tree that holds one.
      if (!state || state.loading) {
        pending += 1
        continue
      }
      added += state.parsed?.added ?? 0
      removed += state.parsed?.removed ?? 0
    }
    return { added, removed, pending }
  }, [entries, diffs])

  return (
    <AppSheet
      label="Working tree changes"
      testId="diff-sheet"
      className="app-sheet-diff"
      title={
        <span className="diff-sheet-title">
          Changes
          {branch && (
            <span className="diff-sheet-branch" title={`on ${branch}`}>
              <GitBranch size={11} aria-hidden="true" />
              <bdi>{branch}</bdi>
            </span>
          )}
        </span>
      }
      toolbar={
        <span className="diff-sheet-toolbar">
          {/* The totals land when every file has: a figure that climbs while
              the fetches arrive is a progress bar wearing a number's clothes. */}
          {totals.pending === 0 && entries.length > 0 && (
            <span className="diff-sheet-totals" title="Lines added and removed against HEAD">
              <span className="diff-count-add">+{totals.added}</span>
              <span className="diff-count-del">−{totals.removed}</span>
            </span>
          )}
          <button
            data-pressable
            type="button"
            className="diff-sheet-tool"
            aria-pressed={wrap}
            title={wrap ? 'Wrap long lines — on' : 'Wrap long lines — off'}
            onClick={() => {
              setWrap((w) => {
                writeWrapPreference(!w)
                return !w
              })
            }}
          >
            <WrapText size={14} aria-hidden="true" />
          </button>
          {!sources && (
            <button
              data-pressable
              type="button"
              className="diff-sheet-tool"
              title="Re-read the working tree"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
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
              parsed={diffs[entry.path]?.parsed}
              selected={entry.path === current?.path}
              rowRef={entry.path === current?.path ? selectedRef : undefined}
              onSelect={() => setSelected(entry.path)}
            />
          ))}
        </nav>
        <div className="diff-pane">
          {current ? (
            <FilePane key={current.path} entry={current} state={diffs[current.path]} wrap={wrap} />
          ) : (
            <div className="diff-empty">Working tree clean.</div>
          )}
        </div>
      </div>
    </AppSheet>
  )
}

/** One rail row: axis badge, file name, its counts, and the folder it lives in. */
function FileRow({
  entry,
  parsed,
  selected,
  rowRef,
  onSelect,
}: {
  entry: StatusEntry
  parsed?: ParsedDiff
  selected: boolean
  rowRef?: React.RefObject<HTMLButtonElement | null>
  onSelect: () => void
}): JSX.Element {
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
}

/** The reading half: what happened to this file, then the diff itself. */
function FilePane({
  entry,
  state,
  wrap,
}: {
  entry: StatusEntry
  state?: DiffState
  wrap: boolean
}): JSX.Element {
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
}

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

type DiffState = {
  loading: boolean
  parsed?: ParsedDiff
  error?: string
  /** There is nothing to diff, and that is not a failure — see the folder case. */
  note?: string
}

/**
 * Git reports an untracked FOLDER as a single entry (`.artifacts/POD-1/`), so
 * there is no file to read and no diff to ask for. That is an answer, not an
 * error: the row states what it is rather than showing "could not be read" in
 * destructive red for a folder that is behaving normally.
 */
const UNTRACKED_FOLDER =
  'A new folder. Git lists it as one entry until something inside it is tracked, so there is no diff to show yet.'

/** A binary blob has no lines. Saying so is the answer; red is for failures. */
const BINARY_FILE = 'A binary file — there are no text lines to diff.'
const TOO_LARGE = 'This file is too large to read here.'

/**
 * Every file's diff, fetched three at a time with the one you are reading
 * first. Prefetching the rest is what makes the rail's counts real and the
 * next click instant; the op is a lock-free `git diff HEAD -- <path>` per file
 * [POD-114], so the cost of reading ahead is a handful of cheap reads at the
 * moment the sheet opens, and none afterwards.
 */
const CONCURRENCY = 3

function useDiffs({
  entries,
  cwd,
  machineId,
  selected,
  sources,
}: {
  entries: StatusEntry[]
  cwd: string
  machineId?: MachineId
  selected: string
  sources?: Record<string, string> | undefined
}): Record<string, DiffState> {
  const { gitDiffFile, readFileScoped } = useStoreSelector(
    (s) => ({ gitDiffFile: s.gitDiffFile, readFileScoped: s.readFileScoped }),
    shallowEqual,
  )
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const inflight = useRef(new Set<string>())
  const running = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A re-probe invalidates everything: the same path can hold a different diff.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new inventory IS the invalidation; the body deliberately reads nothing from it.
  useEffect(() => {
    inflight.current.clear()
    setDiffs({})
  }, [entries])

  const load = useCallback(
    (entry: StatusEntry) => {
      if (inflight.current.has(entry.path)) return
      inflight.current.add(entry.path)
      running.current += 1
      setDiffs((d) => ({ ...d, [entry.path]: { loading: true } }))
      void (async () => {
        let next: DiffState
        try {
          const given = sources?.[entry.path]
          if (given !== undefined) {
            // The caller already HAS the diff — a transcript's own record of what
            // a tool changed. Asking git for it would answer a different
            // question and, for anything already committed, answer "nothing".
            next = { loading: false, parsed: parseDiff(given) }
          } else if (entry.untracked && entry.path.endsWith('/')) {
            next = { loading: false, note: UNTRACKED_FOLDER }
          } else if (entry.untracked) {
            // A new file has no HEAD side, so it is READ rather than diffed. The
            // read refuses a binary or oversized file by naming which it was —
            // and neither is a failure the reader should see in red.
            const r = await readFileScoped({ kind: 'worktree', machineId, root: cwd }, entry.path)
            next =
              r.ok && r.content !== undefined
                ? { loading: false, parsed: parseDiff(untrackedDiff(r.content)) }
                : 'binary' in r && r.binary
                  ? { loading: false, note: BINARY_FILE }
                  : 'tooLarge' in r && r.tooLarge
                    ? { loading: false, note: TOO_LARGE }
                    : {
                        loading: false,
                        error:
                          ('error' in r ? r.error : undefined) ?? 'This file could not be read.',
                      }
          } else {
            const r = await gitDiffFile({ machineId, root: cwd, path: entry.path })
            next = r.ok
              ? { loading: false, parsed: parseDiff(r.output) }
              : { loading: false, error: r.output || 'git could not diff this file.' }
          }
        } catch (e) {
          next = { loading: false, error: e instanceof Error ? e.message : String(e) }
        }
        running.current -= 1
        if (!alive.current) return
        setDiffs((d) => ({ ...d, [entry.path]: next }))
      })()
    },
    [cwd, machineId, gitDiffFile, readFileScoped, sources],
  )

  // The pump: re-entered on every arrival, so a finished fetch frees its slot
  // for the next file in rail order.
  useEffect(() => {
    for (const entry of [
      ...entries.filter((e) => e.path === selected),
      ...entries.filter((e) => e.path !== selected),
    ]) {
      if (running.current >= CONCURRENCY) break
      if (diffs[entry.path] || inflight.current.has(entry.path)) continue
      load(entry)
    }
  }, [entries, selected, diffs, load])

  return diffs
}

// ---------------------------------------------------------------------------

const WRAP_KEY = 'podium:diff-sheet:wrap'

/** Wrapping is a reading preference, so it outlives the sheet that set it. */
function readWrapPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(WRAP_KEY) === '1'
  } catch {
    return false
  }
}

function writeWrapPreference(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(WRAP_KEY, on ? '1' : '0')
  } catch {
    // A blocked storage is not a reason to refuse the toggle.
  }
}
