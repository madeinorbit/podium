import { highlightCode } from '@podium/client-core/code-highlight'
import { useActivityDisclosure } from '@podium/client-core/react'
import {
  type ActivityDisclosureProps,
  formatClock,
  resolveToolEdit,
  toolCategory,
} from '@podium/client-core/values'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { useAgeNow } from '@/lib/clock-hooks'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { cn } from '@/lib/utils'
import { type ChatBlock, failLine, mcpLabel, toolSubject, toolVerdict } from './chat'
import { ToolEditDiff } from './ToolEditDiff'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'
import { WorkGlyph } from './WorkGlyph'

/** How a call NAMES ITSELF in a list: the tool that ran, in the operator's
 *  words rather than the wire's. Shared with the folded run's hover preview
 *  (POD-423) so the two lists can't drift apart. An MCP call is labelled by its
 *  server, not by the raw `mcp__a__b` id. */
export function toolCallLabel(item: TranscriptItem): string {
  return item.toolName ? (mcpLabel(item.toolName) ?? item.toolName) : 'result'
}

/** This module is behind TranscriptFeedBoundary, keeping the highlighter out of
 * the eager app graph. The shared tokenizer has a bounded content cache; memoise
 * the React leaves too, so disclosure/result updates don't rebuild them. */
function BashCommand({ command }: { command: string }): JSX.Element {
  const spans = useMemo(() => {
    let offset = 0
    return highlightCode(command, 'bash').map((token) => {
      const start = offset
      offset += token.text.length
      return (
        <span
          key={start}
          className={token.scope ? `hljs-${token.scope.replaceAll('.', '-')}` : undefined}
        >
          {token.text}
        </span>
      )
    })
  }, [command])
  return <>{spans}</>
}

/** Old records and other harnesses retain their command in toolInput. Only a
 * validated shell-command payload supersedes that explicit legacy fallback. */
function expandedCommand(item: TranscriptItem): {
  command: string | undefined
  truncated: boolean
} {
  if (item.toolInputJson) {
    try {
      const payload: unknown = JSON.parse(item.toolInputJson)
      if (
        payload &&
        typeof payload === 'object' &&
        'kind' in payload &&
        payload.kind === 'shell-command' &&
        'command' in payload &&
        typeof payload.command === 'string'
      ) {
        return {
          command: payload.command,
          truncated: 'truncated' in payload && payload.truncated === true,
        }
      }
    } catch {
      // Malformed retained input must not hide the legacy command.
    }
  }
  return { command: item.toolInput, truncated: false }
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
  onOpenDiff,
  diffPath,
  timed = false,
  forceOpen = false,
  onOpenChange,
  live = false,
  initialOpen,
}: {
  block: ChatBlock
  live?: boolean
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
  /** The call's clock time goes in the opened run's gutter (POD-2286). */
  timed?: boolean
} & ActivityDisclosureProps): JSX.Element {
  const { userOpen, open, toggle } = useActivityDisclosure({ forceOpen, onOpenChange, initialOpen })
  const { item } = block
  const stamp = timed ? parseTs(item.ts) : undefined
  const result = block.result ?? item.toolResult
  const abnormal = item.toolEffects?.some(
    (effect) =>
      effect.kind === 'termination' && (effect.interrupted || effect.timedOutAfterMs !== undefined),
  )
  const verdict = toolVerdict(result, item.toolEffects)
  // The folded row uses only the call summary; its edit payload belongs to
  // the disclosed body. The batch already supplies the sheet's open target.
  const edit = useMemo(() => (open ? resolveToolEdit(item) : undefined), [open, item])
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
  // Parse retained input only when disclosed; collapsed rows use the preview.
  const expanded = useMemo(
    () => (open && isCommand ? expandedCommand(item) : undefined),
    [open, isCommand, item],
  )
  // A Codex script's calls, as the compute path listed them (POD-2144/2146).
  const calls = open ? block.scriptCalls : undefined
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
  const openable = onOpenDiff && diffPath && !item.toolEffects?.length ? diffPath : undefined
  const activate = (): void => {
    if (openable && onOpenDiff) onOpenDiff(openable)
    else toggle()
  }
  return (
    <div
      className="work-line tool-block min-w-0"
      data-verdict={verdict}
      data-state={live ? 'live' : undefined}
      data-open={open ? 'true' : 'false'}
      data-transcript-retain={userOpen ? '' : undefined}
      data-transcript-run-view={forceOpen && !userOpen ? '' : undefined}
    >
      {stamp && (
        <time className="quiet-time" dateTime={item.ts} title={fullTimeLabel(stamp)}>
          {clockLabel(stamp)}
        </time>
      )}
      <button
        data-pressable
        type="button"
        className="work-line-row"
        data-transcript-run-toggle={forceOpen && !userOpen ? '' : undefined}
        onClick={activate}
        {...(openable ? { title: `Open ${openable}` } : { 'aria-expanded': open })}
      >
        <span
          className={cn('work-line-glyph', verdict === 'err' && 'work-line-glyph--err')}
          aria-hidden="true"
        >
          {live ? <WorkingMark size={15} /> : <WorkGlyph item={item} />}
        </span>
        <span className={cn('work-line-phrase', isCommand && 'work-line-code')}>
          {subject ? (isCommand ? subject : `${toolCategory(item).verb} ${subject}`) : label}
        </span>
        {live ? (
          <ToolLiveTimer since={item.ts} />
        ) : (
          item.durationMs !== undefined && (
            <span className="work-line-time">{formatClock(item.durationMs)}</span>
          )
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
      {expanded?.command !== undefined && (expanded.command !== subject || expanded.truncated) && (
        <>
          <pre className="tool-result-full tool-cmd">
            <BashCommand command={expanded.command} />
          </pre>
          {expanded.truncated && (
            <div className="tool-aside">Command truncated — remaining text was not retained.</div>
          )}
        </>
      )}
      {aside && open && <div className="tool-aside">{aside}</div>}
      {calls && calls.length > 0 && (
        <ul className="tool-script-calls">
          {calls.map((call, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a script's call list never reorders
            <li key={index} className="work-line-row">
              <span className="work-line-glyph">
                <WorkGlyph item={{ ...item, toolName: call.tool }} mail={call.tool === 'Mail'} />
              </span>
              <span className={cn('work-line-phrase', call.tool === 'Bash' && 'work-line-code')}>
                {call.input}
              </span>
            </li>
          ))}
        </ul>
      )}
      {verdict === 'err' && (
        <div className="tool-fail-line">
          {abnormal ? 'Tool interrupted or timed out' : failLine(result)}
        </div>
      )}
      {open &&
        item.toolEffects?.map((effect) => {
          let text: string | undefined
          switch (effect.kind) {
            case 'file-edit':
              break
            case 'git-operation':
              text = `Git (reported by harness): ${JSON.stringify(effect.operation)}`
              break
            case 'background-task':
              text = `Background task: ${effect.taskId}`
              break
            case 'termination':
              text = [
                effect.interrupted ? 'Interrupted' : '',
                effect.timedOutAfterMs !== undefined
                  ? `Timed out after ${effect.timedOutAfterMs} ms`
                  : '',
                effect.interpretation,
              ]
                .filter(Boolean)
                .join(' · ')
              break
            case 'unknown':
              text = `Unrecognized tool effect: ${effect.key}`
              break
          }
          return text ? (
            <div
              className="tool-aside"
              key={effect.kind === 'unknown' ? `unknown-${effect.key}` : effect.kind}
            >
              {text}
            </div>
          ) : null
        })}
      {open && edit && <ToolEditDiff edit={edit} />}
      {open && (!edit || isCommand || forceOpen) && (
        <pre className="tool-result-full">{result ?? '(no result captured)'}</pre>
      )}
      {open && edit && !isCommand && !forceOpen && verdict === 'err' && result && (
        <pre className="tool-result-full">{result}</pre>
      )}
    </div>
  )
}

function ToolLiveTimer({ since }: { since: string | undefined }) {
  const started = since ? Date.parse(since) : Number.NaN
  const known = Number.isFinite(started)
  const now = useAgeNow(started, 0, known)
  return known ? (
    <span className="work-line-time">{formatClock(Math.max(0, now - started))}</span>
  ) : null
}
