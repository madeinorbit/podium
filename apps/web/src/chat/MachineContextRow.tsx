import { machineContextLabel } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/protocol'
import type { JSX } from 'react'
import { useState } from 'react'

/** A collapsed machine-authored context block (headless superagent sessions):
 *  a quiet disclosure row that expands to the raw block text. */
export function MachineContextRow({
  item,
  cls,
  index,
}: {
  item: TranscriptItem
  cls: string
  index: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={cls} data-block={index}>
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body py-0.5">
        <button
          type="button"
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="flex-none font-mono text-[10px] text-muted-foreground/50">
            {open ? '▾' : '▸'}
          </span>
          <span className="flex-none text-xs font-semibold text-foreground">
            {machineContextLabel(item.text)}
          </span>
        </button>
        {open && (
          <pre className="mt-1 max-h-[280px] overflow-auto rounded-md border border-border bg-background px-2.5 py-2 text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
            {item.text}
          </pre>
        )}
      </div>
    </div>
  )
}
