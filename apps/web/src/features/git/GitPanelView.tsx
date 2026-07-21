import { shallowEqual } from '@podium/client-core/store'
import type { IssueWire } from '@podium/protocol'
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { GitStamp } from '@/components/GitStamp'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/home'
import {
  diffLineKind,
  entryBadge,
  entryTitle,
  type LogEntry,
  parseLog,
  parseStatus,
  type StatusEntry,
  untrackedDiff,
} from './git-panel'

/** Badge tint per axis: staged = live green, unstaged = warning, untracked muted. */
function badgeClass(e: StatusEntry): string {
  if (e.untracked) return 'text-muted-foreground/70'
  if (e.x !== ' ' && e.y === ' ') return 'text-live'
  return 'text-warning'
}

function DiffBlock({ text }: { text: string }): JSX.Element {
  if (text === '')
    return (
      <div className="px-2 py-1.5 text-[10.5px] text-muted-foreground/70">No textual diff.</div>
    )
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre px-2 py-1.5 font-mono text-[10.5px] leading-[1.5]">
      {text.split('\n').map((line, i) => {
        const kind = diffLineKind(line)
        const cls =
          kind === 'add'
            ? 'text-live'
            : kind === 'del'
              ? 'text-destructive'
              : kind === 'hunk'
                ? 'text-info'
                : kind === 'meta'
                  ? 'text-muted-foreground/60'
                  : 'text-secondary-foreground'
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static line list
          <div key={i} className={cls}>
            {line === '' ? ' ' : line}
          </div>
        )
      })}
    </pre>
  )
}

type DiffState = { loading: boolean; text?: string; error?: string }

/**
 * The right-dock Git tab [POD-114]: working-tree status, per-file diffs and
 * the commit log for the ACTIVE checkout (the panel is keyed by cwd). The
 * header reuses the GitStamp grammar [POD-98] when the checkout maps to an
 * issue with probed git state; commits attributed to that issue are marked.
 */
export function GitPanelView({
  cwd,
  machineId,
  issue,
}: {
  cwd: string
  machineId?: string
  issue?: IssueWire
}): JSX.Element {
  const { gitStatus, gitLog, gitDiffFile, readFileScoped } = useStoreSelector(
    (s) => ({
      gitStatus: s.gitStatus,
      gitLog: s.gitLog,
      gitDiffFile: s.gitDiffFile,
      readFileScoped: s.readFileScoped,
    }),
    shallowEqual,
  )
  const [status, setStatus] = useState<ReturnType<typeof parseStatus> | null>(null)
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [now, setNow] = useState(() => Date.now())

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
      setDiffs({})
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

  const toggleDiff = useCallback(
    (entry: StatusEntry) => {
      const open = diffs[entry.path]
      if (open) {
        setDiffs((d) => {
          const { [entry.path]: _, ...rest } = d
          return rest
        })
        return
      }
      setDiffs((d) => ({ ...d, [entry.path]: { loading: true } }))
      void (async () => {
        try {
          if (entry.untracked) {
            const r = await readFileScoped({ kind: 'worktree', machineId, root: cwd }, entry.path)
            setDiffs((d) => ({
              ...d,
              [entry.path]:
                r.ok && r.content !== undefined
                  ? { loading: false, text: untrackedDiff(r.content) }
                  : { loading: false, error: ('error' in r ? r.error : undefined) ?? 'unreadable' },
            }))
            return
          }
          const r = await gitDiffFile({ machineId, root: cwd, path: entry.path })
          setDiffs((d) => ({
            ...d,
            [entry.path]: r.ok
              ? { loading: false, text: r.output }
              : { loading: false, error: r.output || 'diff failed' },
          }))
        } catch (e) {
          setDiffs((d) => ({
            ...d,
            [entry.path]: { loading: false, error: e instanceof Error ? e.message : String(e) },
          }))
        }
      })()
    },
    [diffs, gitDiffFile, readFileScoped, machineId, cwd],
  )

  const header = status?.header
  const attributed = new Set(issue?.gitState?.commits ?? [])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="git-panel">
      {/* Checkout header — GitStamp grammar [POD-98] when the issue has probed
          state, plain branch line otherwise; upstream drift from the porcelain
          header either way. */}
      <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
        {issue?.gitState ? (
          <GitStamp issueBranch={issue.branch} git={issue.gitState} density="footer" />
        ) : (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] leading-none text-muted-foreground">
            <GitBranch size={11} aria-hidden="true" className="text-muted-foreground/70" />
            <span className="max-w-[24ch] truncate">{header?.branch ?? '…'}</span>
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

      {/* Working tree */}
      <div className="flex-none border-b border-border">
        <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Changes{status ? ` (${status.entries.length})` : ''}
        </div>
        {status && status.entries.length === 0 && (
          <div className="px-3 pb-2.5 text-[11px] text-muted-foreground/70">
            Working tree clean.
          </div>
        )}
        <ul className="pb-1.5">
          {status?.entries.map((e) => {
            const diff = diffs[e.path]
            return (
              <li key={e.path}>
                <button
                  type="button"
                  title={entryTitle(e)}
                  onClick={() => toggleDiff(e)}
                  className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-[3px] text-left font-mono text-[11px] leading-[1.6] hover:bg-secondary/40"
                >
                  {diff ? (
                    <ChevronDown size={11} className="flex-none text-muted-foreground/60" />
                  ) : (
                    <ChevronRight size={11} className="flex-none text-muted-foreground/60" />
                  )}
                  <span className={`w-[2.5ch] flex-none font-semibold ${badgeClass(e)}`}>
                    {entryBadge(e)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-secondary-foreground" dir="rtl">
                    <bdi>{e.path}</bdi>
                  </span>
                </button>
                {diff && (
                  <div className="mx-3 mb-1.5 rounded-[6px] border border-border bg-secondary/30">
                    {diff.loading ? (
                      <div className="animate-pulse px-2 py-1.5 text-[10.5px] text-muted-foreground/70">
                        Loading diff…
                      </div>
                    ) : diff.error ? (
                      <div className="px-2 py-1.5 text-[10.5px] text-destructive">{diff.error}</div>
                    ) : (
                      <DiffBlock text={diff.text ?? ''} />
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {/* Commit log */}
      <div className="flex-none pb-2">
        <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Commits
        </div>
        {log && log.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-muted-foreground/70">No commits yet.</div>
        )}
        <ul>
          {log?.map((c) => (
            <li
              key={c.sha}
              className="group px-3 py-[3px] font-mono text-[11px] leading-[1.6]"
              title={`${c.sha}\n${c.author} — ${c.date}`}
            >
              <div className="flex items-center gap-1.5">
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
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
