import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import type { IssueWire, MachineId } from '@podium/model/browser'
import { ChevronRight, GitBranch, Maximize2, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { GitStamp } from '@/components/GitStamp'
import { Button } from '@/components/ui/button'
import { DiffSheet } from './DiffSheet'
import {
  entryBadge,
  entryTitle,
  entryTone,
  type LogEntry,
  parseCommitFiles,
  parseLog,
  parseStatus,
  type StatusEntry,
} from './git-panel'

/** An unfolded commit's file list: in flight, arrived, or refused. */
type CommitFilesState = { loading: boolean; entries?: StatusEntry[]; error?: string }

/** Three lines of plausible path lengths — enough to read as a list arriving,
 *  short enough that it never claims a size the answer might not have. */
const FILE_SKELETON_WIDTHS = [46, 62, 34]

/** Badge tint per axis: staged reads live, unstaged warning, untracked muted —
 *  and a commit's own files stay dim, because inside a commit there is no axis
 *  left to report. */
function badgeClass(e: StatusEntry): string {
  const tone = entryTone(e)
  return tone === 'untracked' || tone === 'committed'
    ? 'text-muted-foreground/70'
    : tone === 'staged'
      ? 'text-live'
      : 'text-warning'
}

/** One changed-file row — the same object in the working-tree list and under an
 *  unfolded commit, so a file reads the same way wherever the dock shows it. */
function FileRow({
  entry,
  onOpen,
  indent = false,
}: {
  entry: StatusEntry
  onOpen: () => void
  indent?: boolean
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      title={`${entryTitle(entry)}\nOpen the diff`}
      onClick={onOpen}
      className={`group flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-left font-mono text-[11px] leading-[1.6] hover:bg-secondary/40 ${
        indent ? 'pl-[12px]' : 'pl-3'
      }`}
    >
      <span className={`w-[2.5ch] flex-none font-semibold ${badgeClass(entry)}`}>
        {entryBadge(entry)}
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary-foreground" dir="rtl">
        <bdi>{entry.path}</bdi>
      </span>
      {/* The row leads somewhere now, so it says so — on hover only, which keeps
          the resting list as dense as it was. */}
      <ChevronRight
        size={11}
        aria-hidden="true"
        className="flex-none text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  )
}

/**
 * The right-dock Git tab [POD-114]: working-tree status and the commit log for
 * the ACTIVE checkout (the panel is keyed by cwd). The header reuses the
 * GitStamp grammar [POD-98] when the checkout maps to an issue with probed git
 * state; commits attributed to that issue are marked.
 *
 * The dock is the INVENTORY, not the reading surface: a click on a file opens
 * the diff sheet, where the diff gets a whole sheet instead of 300 columns of
 * dock. See DiffSheet.tsx for why the unfold-in-place diff moved out.
 *
 * That holds for HISTORY too [POD-1289]. A commit row unfolds to the files it
 * touched — the same rows, in the same grammar, as the working tree above it —
 * and clicking one opens the same sheet, reading that file's diff out of the
 * commit. Before this, work an agent had already committed was the one thing
 * the panel could prove happened and could not show: `git diff HEAD` answers
 * "nothing changed" about a landed change, which is why the commit ops are
 * their own pair rather than the working-tree one pointed at a sha.
 */
export function GitPanelView({
  cwd,
  machineId,
  issue,
}: {
  cwd: string
  machineId?: MachineId
  issue?: IssueWire
}): JSX.Element {
  const { gitStatus, gitLog, gitCommitFiles } = useStoreSelector(
    (s) => ({ gitStatus: s.gitStatus, gitLog: s.gitLog, gitCommitFiles: s.gitCommitFiles }),
    shallowEqual,
  )
  const [status, setStatus] = useState<ReturnType<typeof parseStatus> | null>(null)
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * What the diff sheet is open on; null while it is closed. A `commit` makes
   * the path a file INSIDE that commit rather than one in the working tree —
   * the same sheet, reading from history instead of from disk.
   */
  const [reading, setReading] = useState<{ path: string; commit?: LogEntry } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** Which commit rows are unfolded, and what each one's file list came back as. */
  const [openShas, setOpenShas] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [commitFiles, setCommitFiles] = useState<Record<string, CommitFilesState>>({})
  const filesInflight = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [st, lg] = await Promise.all([
        gitStatus({ machineId, root: cwd }),
        gitLog({ machineId, root: cwd }),
      ])
      setError(st.ok ? null : st.output || 'git status failed')
      setStatus(st.ok ? parseStatus(st.output) : null)
      setLog(lg.ok ? parseLog(lg.output) : [])
      setNow(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [gitStatus, gitLog, machineId, cwd])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Unfold: fetch the commit's file list once. A sha IS its content, so this
   * cache never goes stale and a refresh deliberately does not clear it — the
   * files of `88af79d` are the files of `88af79d` for as long as the repo
   * exists. Re-folding a row keeps them, so the second look is instant.
   */
  useEffect(() => {
    for (const sha of openShas) {
      if (commitFiles[sha] || filesInflight.current.has(sha)) continue
      filesInflight.current.add(sha)
      setCommitFiles((prev) => ({ ...prev, [sha]: { loading: true } }))
      void (async () => {
        let next: CommitFilesState
        try {
          const r = await gitCommitFiles({ machineId, root: cwd, sha })
          next = r.ok
            ? { loading: false, entries: parseCommitFiles(r.output) }
            : { loading: false, error: r.output || 'git could not read this commit.' }
        } catch (e) {
          next = { loading: false, error: e instanceof Error ? e.message : String(e) }
        }
        setCommitFiles((prev) => ({ ...prev, [sha]: next }))
      })()
    }
  }, [openShas, commitFiles, gitCommitFiles, machineId, cwd])

  const toggleCommit = useCallback((sha: string) => {
    setOpenShas((prev) => {
      const next = new Set(prev)
      if (!next.delete(sha)) next.add(sha)
      return next
    })
  }, [])

  const header = status?.header
  const attributed = new Set(issue?.gitState?.commits ?? [])
  const readingCommitFiles = reading?.commit ? (commitFiles[reading.commit.sha]?.entries ?? []) : []

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="git-panel">
      {/* Checkout header — GitStamp grammar [POD-98] when the issue has probed
          state, plain branch line otherwise; upstream drift from the porcelain
          header either way. */}
      <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
        {issue?.gitState ? (
          <GitStamp issueBranch={issue.branch} git={issue.gitState} density="panel" />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-[12.5px] leading-[1.35] text-secondary-foreground">
            <GitBranch
              size={13}
              aria-hidden="true"
              className="flex-none text-muted-foreground/70"
            />
            <span className="break-all font-semibold">{header?.branch ?? '…'}</span>
          </span>
        )}
        {header?.upstream && (
          <span
            className="font-mono text-[10px] leading-none text-muted-foreground/70"
            title={`upstream ${header.upstream}`}
          >
            {header.upstream}
            {header.ahead > 0 && ` ↑${header.ahead}`}
            {header.behind > 0 && ` ↓${header.behind}`}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto size-6 flex-none text-muted-foreground"
          title="Refresh"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
        </Button>
      </div>

      {error && (
        <div className="border-b border-border px-3 py-2 text-[11px] text-destructive">{error}</div>
      )}

      {/* Working tree — the inventory. Reading happens in the sheet. */}
      <div className="flex-none border-b border-border">
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Changes{status ? ` (${status.entries.length})` : ''}
          </span>
          {status && status.entries.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-5 flex-none text-muted-foreground/70"
              title="Open the diff viewer"
              onClick={() => {
                const first = status.entries[0]
                if (first) setReading({ path: first.path })
              }}
            >
              <Maximize2 size={11} aria-hidden="true" />
            </Button>
          )}
        </div>
        {status && status.entries.length === 0 && (
          <div className="px-3 pb-2.5 text-[11px] text-muted-foreground/70">
            Working tree clean.
          </div>
        )}
        <ul className="pb-1.5">
          {status?.entries.map((e) => (
            <li key={e.path}>
              <FileRow entry={e} onOpen={() => setReading({ path: e.path })} />
            </li>
          ))}
        </ul>
      </div>

      {/* Commit log — the CHECKOUT's history, deliberately not filtered to the
          task: the section title + subline make that scope explicit. */}
      <div className="flex-none pb-2">
        <div className="px-3 pt-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Repo history
        </div>
        <div className="px-3 pb-1.5 text-[10.5px] leading-snug text-muted-foreground/60">
          All recent commits on this checkout
          {attributed.size > 0 && (
            <>
              {' · '}
              <span
                className="mb-[1px] inline-block size-[6px] rounded-full align-middle"
                style={{ background: 'var(--live)' }}
                aria-hidden="true"
              />{' '}
              = this task&rsquo;s
            </>
          )}
        </div>
        {log && log.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-muted-foreground/70">No commits yet.</div>
        )}
        <ul>
          {log?.map((c) => {
            const open = openShas.has(c.sha)
            const files = commitFiles[c.sha]
            return (
              <li key={c.sha}>
                {/* THE COMMIT ROW UNFOLDS [POD-1289]. It used to be inert text:
                    proof that something had happened, with no way to ask what.
                    The subject stays the row — the disclosure is the whole line,
                    because a 7px twisty in a 300px dock is a target you aim at
                    rather than click. */}
                <button
                  data-pressable
                  type="button"
                  aria-expanded={open}
                  title={`${c.sha}\n${c.author} — ${c.date}\n${open ? 'Hide' : 'Show'} the files this commit changed`}
                  onClick={() => toggleCommit(c.sha)}
                  className="group flex w-full cursor-pointer items-center gap-1.5 px-3 py-[3px] text-left font-mono text-[11px] leading-[1.6] hover:bg-secondary/40"
                >
                  <ChevronRight
                    size={11}
                    aria-hidden="true"
                    className={`flex-none text-muted-foreground/50 transition-transform group-hover:text-muted-foreground ${
                      open ? 'rotate-90' : ''
                    }`}
                  />
                  <span className="flex-none text-muted-foreground/70">{c.shortSha}</span>
                  {attributed.has(c.sha) && (
                    <span
                      className="size-[6px] flex-none rounded-full"
                      style={{ background: 'var(--live)' }}
                      title={`Attributed to ${issue?.displayRef ?? 'this task'} [POD-98]`}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-secondary-foreground">
                    {c.subject}
                  </span>
                  <span className="flex-none text-[10px] text-muted-foreground/60">
                    {relativeTime(c.date, now)}
                  </span>
                </button>
                {open && (
                  // A rule dropped from the twisty ties the files to the row
                  // that opened them. Fourteen dim paths between two commits
                  // otherwise read as a list that belongs to neither — and the
                  // dock is 300px, so indentation alone is not enough distance
                  // to say "these are inside that".
                  <div
                    className="mb-1 ml-[17px] border-l border-border pl-px"
                    data-testid={`commit-files-${c.shortSha}`}
                  >
                    {files?.error ? (
                      <div className="py-1 pl-3 text-[11px] text-destructive">{files.error}</div>
                    ) : files?.entries ? (
                      files.entries.length === 0 ? (
                        <div className="py-1 pl-3 text-[11px] text-muted-foreground/70">
                          No files — this commit changed nothing on this branch.
                        </div>
                      ) : (
                        files.entries.map((e) => (
                          <FileRow
                            key={e.path}
                            entry={e}
                            indent
                            onOpen={() => setReading({ path: e.path, commit: c })}
                          />
                        ))
                      )
                    ) : (
                      // Loading is a shape (POD-394): the answer is a short list
                      // of paths, so the wait is drawn as short lines of paths.
                      <div className="flex flex-col gap-[5px] py-[6px] pl-3" aria-hidden="true">
                        {FILE_SKELETON_WIDTHS.map((w) => (
                          <span
                            key={w}
                            className="h-[7px] animate-pulse rounded-full bg-muted-foreground/20"
                            style={{ width: `${w}%` }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {/* The sheet is fixed to the window, not to the dock — it opens from here
          because this is where the file lists and their probes live, and it
          closes back onto the same list. The working-tree sheet is dropped the
          moment the tree has nothing to show, so a refresh that lands clean
          cannot leave an empty reader open over the shell. */}
      {reading?.commit && readingCommitFiles.length > 0 ? (
        // A commit's diff comes out of history, so nothing about it can go
        // stale: no re-probe, and the sheet stays valid while the working tree
        // moves underneath it.
        <DiffSheet
          cwd={cwd}
          machineId={machineId}
          entries={readingCommitFiles}
          commit={{
            sha: reading.commit.sha,
            shortSha: reading.commit.shortSha,
            subject: reading.commit.subject,
          }}
          initialPath={reading.path}
          refreshing={false}
          onRefresh={() => {}}
          onClose={() => setReading(null)}
        />
      ) : reading && !reading.commit && status && status.entries.length > 0 ? (
        <DiffSheet
          cwd={cwd}
          machineId={machineId}
          entries={status.entries}
          branch={header?.branch ?? issue?.branch ?? null}
          initialPath={reading.path}
          refreshing={loading}
          onRefresh={() => void refresh()}
          onClose={() => setReading(null)}
        />
      ) : null}
    </div>
  )
}
