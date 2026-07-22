import type { JSX } from 'react'
import { useState } from 'react'
import { resolveAgainstCwd } from '@/lib/file-path'
import { cn } from '@/lib/utils'
import { type ChatBlock, failLine, toolVerdict } from './chat'

/** One tool call inside an expanded batch (Flat Field, POD-159): a muted
 *  one-line mono row — verdict glyph, name, input preview, inline file links —
 *  with a failed call's first result line surfaced beneath it. Click toggles
 *  the full result. No outer row/rail/[data-block] — the batch row owns the
 *  layout column and the minimap tick. */
export function ToolBlock({
  block,
  sessionId,
  cwd,
  openFile,
}: {
  block: ChatBlock
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  const verdict = toolVerdict(result)
  // Orphan results render as a bare result row; calls render name + input.
  const label = item.toolName ?? 'result'
  return (
    <div className="min-w-0">
      <button
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
        <span className="flex-none font-semibold text-[10.5px]">{label}</span>
        {(item.toolTitle ?? item.toolInput) && (
          <span className="min-w-0 truncate opacity-70">{item.toolTitle ?? item.toolInput}</span>
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
      {verdict === 'err' && !open && <div className="tool-fail-line">{failLine(result)}</div>}
      {open && (
        <pre className="my-1 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
          {result ?? '(no result captured)'}
        </pre>
      )}
    </div>
  )
}
