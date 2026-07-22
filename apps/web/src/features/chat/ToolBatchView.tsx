import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { type ToolBatchRow, toolVerdict } from './chat'
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
  // Any failed call in the run is surfaced on the collapsed line — failure must
  // never be invisible behind a disclosure (Flat Field, POD-159).
  const failed = row.blocks.filter(
    (b) => toolVerdict(b.result ?? b.item.toolResult) === 'err',
  ).length
  return (
    <div className={rowClass} data-block={index}>
      {/* No rail — tool activity stays quiet, aligned with prose via the spacer. */}
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body py-0.5">
        <button
          type="button"
          className="tool-row cursor-pointer py-0.5 text-left hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
          title={row.title}
        >
          <span className="tool-glyph" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="min-w-0 truncate font-sans text-[12px] text-muted-foreground">
            {row.title}
          </span>
          {failed > 0 && (
            <span className="flex-none font-semibold text-[10px] text-destructive">
              ✕ {failed} failed
            </span>
          )}
          <span className="ml-auto flex-none text-[10px] tabular-nums opacity-60">{count}</span>
        </button>
        {expanded && (
          <div className="mt-0.5 ml-[5px] flex flex-col gap-0.5 pl-2.5">
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
