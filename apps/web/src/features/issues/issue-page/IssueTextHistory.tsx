/**
 * A TASK'S DESCRIPTION OR BRIEF HISTORY, WITH RESTORE (POD-6295; design §2.2,
 * §4.4).
 *
 * Every member edits a task's text, so each edit is kept as an attributed
 * revision and any of them can be put back. The list is read on request, when
 * the reader opens it, and read again after a restore. Each line names the
 * member the revision was written for. Restore is drawn only where the server
 * said the reader may (`allowed.restore`), and never on the text the field
 * holds now; the restore is itself a new revision, so nothing is rewritten.
 */
import { eventStamp } from '@podium/client-core/values'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { History } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMemberRoster } from '@/lib/member-roster'
import type { IssueTextRevision } from '../issue-page-commands'
import { IssueAge } from './IssueAge'
import { issueObserver as observer } from './issue-observer'
import { type MemberNamer, personName } from './issue-provenance'

/** How a revision came to be, as one line. */
export function revisionLine(revision: IssueTextRevision, nameOf?: MemberNamer): string {
  const who = revision.onBehalfOf ?? revision.actor
  const name = who ? personName(who, nameOf) : undefined
  switch (revision.source) {
    case 'baseline':
      return 'Text from before history was kept'
    case 'create':
      return name ? `${name} wrote it` : 'Written'
    case 'restore':
      return name ? `${name} restored an earlier version` : 'Restored an earlier version'
    default:
      return name ? `${name} edited` : 'Edited'
  }
}

export const IssueTextHistory = observer(function IssueTextHistory({
  issueId,
  field,
  current,
  mayRestore,
  busy,
  onRestore,
  load,
}: {
  issueId: string
  field: 'description' | 'brief'
  /** The text the field holds now: its revision gets no Restore. */
  current: string
  /** The server's answer for this reader (`allowed.restore`). */
  mayRestore: boolean
  busy: boolean
  onRestore: (revisionId: number, done: () => void) => void
  /** Read the field's revisions, oldest first (`issues.textRevisions`). */
  load: () => Promise<IssueTextRevision[]>
}): JSX.Element {
  const roster = useMemberRoster()
  const [open, setOpen] = useState(false)
  const [history] = useState(() => new RequestAnswer<IssueTextRevision[]>())
  const read = () => void history.load(load)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on open and on a new task only
  useEffect(() => {
    if (open) read()
    else history.close()
  }, [open, issueId])
  useEffect(() => () => history.close(), [history])
  const revisions = [...(history.answer ?? [])].reverse()
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid={`${field}-history`}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 self-start px-1.5 text-[11.5px] text-text-faint"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid={`${field}-history-toggle`}
      >
        <History size={12} aria-hidden="true" /> {open ? 'Hide history' : 'History'}
      </Button>
      {open && (
        <ol className="flex flex-col gap-1.5 border-border/60 border-l pl-3">
          {history.loading && revisions.length === 0 && (
            <li className="text-[12px] text-text-faint">Loading history…</li>
          )}
          {history.error && (
            <li role="alert" className="text-[12px] text-destructive">
              Could not load the history: {history.error}
            </li>
          )}
          {!history.loading && !history.error && revisions.length === 0 && (
            <li className="text-[12px] text-text-faint">No earlier versions.</li>
          )}
          {revisions.map((revision) => (
            <li
              key={revision.id}
              className="flex flex-col gap-0.5 text-[12px]"
              data-testid="text-revision"
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">
                  {revisionLine(revision, (id) => roster?.nameOf(id))}
                </span>
                <span
                  className="flex-none font-mono shell-type-micro text-text-faint tabular-nums"
                  title={eventStamp(revision.createdAt)}
                >
                  <IssueAge stamp={revision.createdAt} />
                </span>
                {mayRestore && revision.body !== current && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    className="h-5 px-1.5 text-[11px]"
                    onClick={() => onRestore(revision.id, read)}
                    data-testid="text-revision-restore"
                  >
                    Restore
                  </Button>
                )}
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-[12px] text-text-faint">
                {revision.body || '(empty)'}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
})
