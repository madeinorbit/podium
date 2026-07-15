import type { JSX } from 'react'

/**
 * Render the exact shell command as one text node. `white-space: pre` preserves
 * its ordinary ASCII spaces without reconstructing or altering any characters.
 */
export function ResumeCommandDisplay({ command }: { command: string }): JSX.Element {
  return (
    <span className="truncate whitespace-pre" aria-hidden="true">
      {command}
    </span>
  )
}
