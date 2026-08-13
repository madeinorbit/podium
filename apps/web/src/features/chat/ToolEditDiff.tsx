import {
  type ToolEditLine,
  type ToolEditView,
  toolEditLines,
  toolEditMagnitude,
} from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/** Compact add/delete listing for one file-edit tool call. Same colour
 *  vocabulary as the git sheet (blue adds, red removes — the theme has no
 *  green) but none of that sheet's gutters or sticky chrome: this sits inside
 *  a 280px tool row. */
export function ToolEditDiff({ edit }: { edit: ToolEditView }): JSX.Element {
  const { lines, omitted } = toolEditLines(edit)
  const magnitude = toolEditMagnitude(edit)
  return (
    <div className="tool-edit-diff" data-testid="tool-edit-diff">
      <div className="tool-edit-head">
        <span className="tool-edit-head-label">{edit.mode === 'write' ? 'new file' : 'diff'}</span>
        <span className="tool-edit-mag">{magnitude}</span>
      </div>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static parsed list
        <DiffLine key={i} line={line} />
      ))}
      {omitted > 0 && (
        <div className="tool-edit-line tool-edit-line--note">
          +{omitted} more lines — open the file
        </div>
      )}
    </div>
  )
}

function DiffLine({ line }: { line: ToolEditLine }): JSX.Element {
  if (line.kind === 'hunk' || line.kind === 'meta') {
    return <div className="tool-edit-line tool-edit-line--hunk">{line.text}</div>
  }
  if (line.kind === 'note') {
    return <div className="tool-edit-line tool-edit-line--note">{line.text}</div>
  }
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  return (
    <div
      className={cn(
        'tool-edit-line',
        line.kind === 'add' && 'tool-edit-line--add',
        line.kind === 'del' && 'tool-edit-line--del',
      )}
    >
      <span className="tool-edit-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="tool-edit-code">{line.text === '' ? ' ' : line.text}</span>
    </div>
  )
}
