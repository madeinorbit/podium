import type { SessionId, TranscriptItem } from '@podium/model'
import type { JSX } from 'react'
import { useState } from 'react'
import { resolveAgainstCwd } from '@/lib/file-path'
import { cn } from '@/lib/utils'
import { type ChatBlock, failLine, mcpLabel, resultPreview, toolVerdict } from './chat'

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
 *  the full result. No outer row/rail/[data-block] — the batch row owns the
 *  layout column and the minimap tick.
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
}: {
  block: ChatBlock
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  const verdict = toolVerdict(result)
  const preview = resultPreview(result)
  // Orphan results render as a bare result row; calls render name + input.
  const label = toolCallLabel(item)
  // Bash shows the COMMAND, with the agent's description beneath it — the
  // command is the thing that ran, and it is what a reader is checking for.
  const command = item.toolName === 'Bash' ? item.toolInput : undefined
  const subject = command ?? item.toolTitle ?? item.toolInput
  const aside = command && item.toolTitle ? item.toolTitle : undefined
  return (
    <div className="tool-block min-w-0" data-verdict={verdict}>
      <button
        data-pressable
        type="button"
        className="tool-row cursor-pointer py-0.5 text-left hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
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
        <span className="min-w-[46px] flex-none font-semibold text-[10.5px]">{label}</span>
        {subject && (
          <span className={cn('min-w-0 truncate', command ? 'tool-cmd' : 'opacity-70')}>
            {subject}
          </span>
        )}
        {item.toolPaths && item.toolPaths.length > 0 && (
          <span className="ml-auto flex flex-none gap-2">
            {item.toolPaths.slice(0, 2).map((p) => (
              // Nested interactive content inside the toggle button is invalid;
              // spans with onClick keep the row a single button while file names
              // stay individually clickable.
              // biome-ignore lint/a11y/useKeyWithClickEvents: the enclosing button carries keyboard access to the row; file opening is also reachable from the expanded result
              // biome-ignore lint/a11y/noStaticElementInteractions: see above
              <span
                key={p}
                className="cursor-pointer border-b border-border text-[10px] hover:text-foreground"
                title={`Open ${p}`}
                onClick={(e) => {
                  e.stopPropagation()
                  openFile(sessionId, resolveAgainstCwd(cwd, p))
                }}
              >
                {p.split('/').pop()}
              </span>
            ))}
          </span>
        )}
      </button>
      {/* The agent's own words about a command it ran — kept, but demoted below
          the command itself. */}
      {aside && !open && <div className="tool-aside">{aside}</div>}
      {verdict === 'err' && !open && <div className="tool-fail-line">{failLine(result)}</div>}
      {/* What the call returned, one line, without a further click. Suppressed
          for failures (the fail line above already carries the first line) and
          once the full result is open. */}
      {verdict !== 'err' && !open && preview && (
        <div className="tool-out">
          <span className="tool-out-line">{preview.line}</span>
          {preview.more > 0 && (
            <span className="tool-out-more">
              +{preview.more} {preview.more === 1 ? 'line' : 'lines'}
            </span>
          )}
        </div>
      )}
      {open && <pre className="tool-result-full">{result ?? '(no result captured)'}</pre>}
    </div>
  )
}
