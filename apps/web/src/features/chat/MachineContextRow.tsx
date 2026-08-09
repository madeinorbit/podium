import { machineContextLabel } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
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
          data-pressable
          type="button"
          className="machine-context-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="machine-context-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="machine-context-kind">Context · machine</span>
          <span className="machine-context-label">{machineContextLabel(item.text)}</span>
          {item.ts && (
            <time className="machine-context-time" dateTime={item.ts}>
              {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          )}
        </button>
        {open && <pre className="machine-context-body">{item.text}</pre>}
      </div>
    </div>
  )
}
