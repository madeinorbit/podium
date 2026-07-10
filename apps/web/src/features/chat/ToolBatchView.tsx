import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ToolBatchRow } from './chat'
import { ToolBlock } from './ToolBlock'

/**
 * A run of consecutive tool calls, collapsed under one smart summary title
 * ("Read 2 files, ran a command"). Quiet by default; click the title to reveal
 * the individual calls. One [data-block] row → one minimap tick, so the batch
 * reads as a single beat of activity. Search auto-expands it via `forceOpen`.
 */
export function ToolBatchView({
  row,
  index,
  highlighted,
  dimmed,
  forceOpen,
  sessionId,
  cwd,
  openFile,
}: {
  row: ToolBatchRow
  index: number
  highlighted: boolean
  dimmed: boolean
  forceOpen: boolean
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  const rowClass = cn(
    'transcript-row mx-auto w-full max-w-[900px]',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
    dimmed && 'opacity-35',
  )
  return (
    <div className={rowClass} data-block={index}>
      {/* No rail — tool activity stays quiet, aligned with prose via the spacer. */}
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body py-0.5">
        <button
          type="button"
          className="flex w-full min-w-0 items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="flex-none font-mono text-[10px] text-muted-foreground/50">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/90">
            {row.title}
          </span>
        </button>
        {expanded && (
          <div className="mt-0.5 ml-[5px] flex flex-col gap-0.5 border-l border-border/60 pl-2.5">
            {row.blocks.map((b) => (
              <ToolBlock
                key={b.item.id}
                block={b}
                sessionId={sessionId}
                cwd={cwd}
                openFile={openFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
