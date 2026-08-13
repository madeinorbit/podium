import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import type { IssueWire, MachineId } from '@podium/model/browser'
import { ChevronRight, GitBranch, Maximize2, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { GitStamp } from '@/components/GitStamp'
import { Button } from '@/components/ui/button'
import { DiffSheet } from './DiffSheet'
import {
  entryBadge,
  entryTitle,
  entryTone,
  type LogEntry,
  parseLog,
  parseStatus,
  type StatusEntry,
} from './git-panel'

/** Badge tint per axis: staged reads live, unstaged warning, untracked muted. */
function badgeClass(e: StatusEntry): string {
  const tone = entryTone(e)
  return tone === 'untracked'
    ? 'text-muted-foreground/70'
    : tone === 'staged'
      ? 'text-live'
      : 'text-warning'
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
  const { gitStatus, gitLog } = useStoreSelector(
    (s) => ({ gitStatus: s.gitStatus, gitLog: s.gitLog }),
    shallowEqual,
  )
  const [status, setStatus] = useState<ReturnType<typeof parseStatus> | null>(null)
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** The file the diff sheet is open on; null while it is closed. */
  const [reading, setReading] = useState<string | null>(null)
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

  const header = status?.header
  const attributed = new Set(issue?.gitState?.commits ?? [])

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
              onClick={() => setReading(status.entries[0]?.path ?? null)}
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
              <button
                data-pressable
                type="button"
                title={`${entryTitle(e)}\nOpen the diff`}
                onClick={() => setReading(e.path)}
                className="group flex w-full cursor-pointer items-center gap-1.5 px-3 py-[3px] text-left font-mono text-[11px] leading-[1.6] hover:bg-secondary/40"
              >
                <span className={`w-[2.5ch] flex-none font-semibold ${badgeClass(e)}`}>
                  {entryBadge(e)}
                </span>
                <span className="min-w-0 flex-1 truncate text-secondary-foreground" dir="rtl">
                  <bdi>{e.path}</bdi>
                </span>
                {/* The row leads somewhere now, so it says so — on hover only,
                    which keeps the resting list as dense as it was. */}
                <ChevronRight
                  size={11}
                  aria-hidden="true"
                  className="flex-none text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
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

      {/* The sheet is fixed to the window, not to the dock — it opens from here
          because this is where the file list and its probe live, and it closes
          back onto the same list. It is dropped the moment the working tree has
          nothing to show, so a refresh that lands clean cannot leave an empty
          reader open over the shell. */}
      {reading !== null && status && status.entries.length > 0 && (
        <DiffSheet
          cwd={cwd}
          machineId={machineId}
          entries={status.entries}
          branch={header?.branch ?? issue?.branch ?? null}
          initialPath={reading}
          refreshing={loading}
          onRefresh={() => void refresh()}
          onClose={() => setReading(null)}
        />
      )}
    </div>
  )
}
