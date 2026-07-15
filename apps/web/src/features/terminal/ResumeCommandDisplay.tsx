import type { JSX } from 'react'

/**
 * Render the executable separator as a fixed-width glyph. The shell command keeps
 * ordinary ASCII spaces for copying, while the visible pill cannot collapse the
 * first separator and read as `claude--resume`.
 */
export function ResumeCommandDisplay({ command }: { command: string }): JSX.Element {
  const separator = command.indexOf(' ')
  if (separator === -1) return <span aria-hidden="true">{command}</span>

  return (
    <span className="inline-flex min-w-0 overflow-hidden" aria-hidden="true">
      <span className="flex-none">{command.slice(0, separator)}</span>
      <span className="inline-block w-[1ch] flex-none">{'\u00a0'}</span>
      <span className="truncate">{command.slice(separator + 1)}</span>
    </span>
  )
}
