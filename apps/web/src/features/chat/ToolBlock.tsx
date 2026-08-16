import { parseToolEdit, toolEditMagnitude } from '@podium/client-core/viewmodels'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
import type { JSX } from 'react'
import { useState } from 'react'
import { resolveAgainstCwd } from '@/lib/file-path'
import { cn } from '@/lib/utils'
import {
  type ChatBlock,
  failLine,
  mcpLabel,
  resultPreview,
  toolSubject,
  toolVerdict,
} from './chat'
import { ToolEditDiff } from './ToolEditDiff'

/** How a call NAMES ITSELF in a list: the tool that ran, in the operator's
 *  words rather than the wire's. Shared with the folded run's hover preview
 *  (POD-423) so the two lists can't drift apart. An MCP call is labelled by its
 *  server, not by the raw `mcp__a__b` id. */
export function toolCallLabel(item: TranscriptItem): string {
  return item.toolName ? (mcpLabel(item.toolName) ?? item.toolName) : 'result'
}

/** One tool call inside an expanded batch (Flat Field, POD-159): a muted
 *  one-line mono row — verdict glyph, name, input preview, inline file links —
 *  with a failed call's first result line surfaced beneath it. Click toggles
 *  the full result, or the file-edit diff when the call carried one. No outer
 *  row/rail/[data-block] — the batch row owns the layout column and the
 *  minimap tick.
 *
 *  POD-376: the row now shows the call's OWN subject rather than only the
 *  agent's description of it, and previews what the call returned. Reaching a
 *  command's output used to take three clicks (open the run, open the row, read)
 *  — a reader who unfolded the run has already asked for this. */
export function ToolBlock({
  block,
  sessionId,
  cwd,
  openFile,
  onOpenDiff,
  diffPath,
}: {
  block: ChatBlock
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
  /** Open this call's file in the run's diff sheet. Absent → the row falls back
   *  to unfolding its diff in place, which is what happens anywhere the sheet
   *  cannot be mounted. */
  onOpenDiff?: ((path: string) => void) | undefined
  /** The path this row opens, already resolved and normalised by the batch that
   *  owns the sheet. Absent → this call changed nothing the sheet can show, and
   *  the row unfolds instead. Deciding this here rather than in the row is what
   *  keeps the rail and the rows describing the same set of files. */
  diffPath?: string | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  const verdict = toolVerdict(result)
  const edit = parseToolEdit(item.toolInputJson)
  const preview = edit ? undefined : resultPreview(result)
  const editPreview = edit ? toolEditMagnitude(edit) : undefined
  // Orphan results render as a bare result row; calls render name + input.
  const label = toolCallLabel(item)
  // THE SHORT FORM, WHICH IS THE HOVER PANEL'S (POD-993 round 7). This row used
  // to print the raw `toolInput` — an eighty-character worktree path, or a whole
  // heredoc for a Bash call — so an unfolded run of twelve calls was twelve
  // lines that each ran off the end of the column. `toolSubject` is the sentence
  // the collapsed line and the retired preview panel were both built from:
  // basenames, MCP labels, the first line of a command.
  //
  // UNCAPPED, though. "Shorter" meant the short FORM — a basename instead of an
  // eighty-character worktree path — not a clipped string: the collapsed line
  // caps each subject at 30 characters because several share one line, and
  // inheriting that here put "…" into the middle of filenames on rows with a
  // whole line to spare. The column edge is CSS's job (`truncate` below), which
  // clips only what genuinely does not fit and only ever at the end.
  const subject = toolSubject(item, Number.POSITIVE_INFINITY)
  const isCommand = item.toolName === 'Bash'
  // The agent's own description of a command it ran — a detail, so it stays
  // behind this row's own disclosure, which is exactly where the operator asked
  // for details to live.
  const aside = isCommand && item.toolTitle ? item.toolTitle : undefined
  // A CALL THAT CHANGED A FILE OPENS THE FILE. For everything else the row's own
  // click is still the only way to see what it returned, so the two behaviours
  // live on the same control rather than adding a second one beside it.
  //
  // This row used to pick the path itself — `edit.path ?? toolPaths[0]` — which
  // could name a file the call only READ, and which the sheet then had no diff
  // for. The batch resolves it now, from the recorded edit alone.
  const openable = onOpenDiff && diffPath ? diffPath : undefined
  const activate = (): void => {
    if (openable && onOpenDiff) onOpenDiff(openable)
    else setOpen((v) => !v)
  }
  return (
    <div className="tool-block min-w-0" data-verdict={verdict}>
      <button
        data-pressable
        type="button"
        className="tool-row cursor-pointer py-0.5 text-left hover:text-foreground"
        onClick={activate}
        {...(openable ? { title: `Open ${openable}` } : { 'aria-expanded': open })}
      >
        <span
          className={cn(
            'tool-glyph',
            verdict === 'ok' && 'tool-glyph--ok',
            verdict === 'err' && 'tool-glyph--err',
          )}
          aria-hidden="true"
        >
          {verdict === 'err' ? '✕' : verdict === 'ok' ? '✓' : '·'}
        </span>
        {/* A floor, not a cap: short names share one column so the targets line
            up to a single left edge; a long one (NotebookEdit) still shows in
            full rather than truncating to nothing. */}
        <span className="tool-name">{label}</span>
        {subject && (
          <span className={cn('min-w-0 truncate', isCommand ? 'tool-cmd' : 'tool-subject')}>
            {subject}
          </span>
        )}
      </button>
      {/* NOTHING ON THE FIRST LAYER (POD-993 round 3). An unfolded run used to
          carry, under every row, the agent's aside and a preview line of what
          the call returned — so opening a run of twelve calls produced
          twenty-four lines of half-detail nobody asked for, and the list stopped
          being scannable, which is the only thing a list of calls is for. The
          run now reads as the design draws it: one line per call, verdict, name,
          target. What a call SAID is one click away, on that call.

          The exception is a FAILURE, which is not detail — it is the verdict,
          and a reader who has to click to discover that something broke has been
          told the wrong thing by the row above it. */}
      {aside && open && <div className="tool-aside">{aside}</div>}
      {verdict === 'err' && <div className="tool-fail-line">{failLine(result)}</div>}
      {open && edit && <ToolEditDiff edit={edit} />}
      {open && !edit && <pre className="tool-result-full">{result ?? '(no result captured)'}</pre>}
      {open && edit && verdict === 'err' && result && (
        <pre className="tool-result-full">{result}</pre>
      )}
    </div>
  )
}
