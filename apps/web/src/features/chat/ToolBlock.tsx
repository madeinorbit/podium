import type { JSX } from 'react'
import { useState } from 'react'
import { resolveAgainstCwd } from '@/lib/file-path'
import type { ChatBlock } from './chat'

/** One tool call inside an expanded batch: name + input preview, file chips, and
 *  a click-to-reveal result. No outer row/rail/[data-block] — the batch row owns
 *  the layout column and the minimap tick. */
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
  // Orphan results render as a bare result row; calls render name + input.
  const label = item.toolName ?? 'result'
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex-none font-mono text-[10px] text-muted-foreground/50">
          {open ? '▾' : '▸'}
        </span>
        <span className="flex-none font-mono text-[11px] font-semibold text-muted-foreground/80">
          {label}
        </span>
        {item.toolInput && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/50">
            {item.toolInput}
          </span>
        )}
      </button>
      {item.toolPaths?.map((p) => (
        <button
          key={p}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            openFile(sessionId, resolveAgainstCwd(cwd, p))
          }}
          className="ml-[17px] inline-flex max-w-full items-center gap-1 truncate rounded border border-input px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`Open ${p}`}
        >
          {p.split('/').pop()}
        </button>
      ))}
      {open && (
        <pre className="my-1 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
          {result ?? '(no result captured)'}
        </pre>
      )}
    </div>
  )
}
