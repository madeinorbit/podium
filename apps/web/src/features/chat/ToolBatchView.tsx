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
    'transcript-row mx-auto w-full max-w-[960px]',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
    dimmed && 'opacity-35',
  )
  const count = row.blocks.length
  const toolNames = row.blocks
    .map((b) => b.item.toolName)
    .filter(Boolean)
    .join(' · ')
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
          title={row.title}
        >
          <span className="flex-none font-mono text-[10px] text-[#6c6c78]">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="flex-none text-[12px] font-semibold text-foreground">
            {count} tool{count === 1 ? '' : 's'}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-[#6c6c78]">{toolNames}</span>
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
