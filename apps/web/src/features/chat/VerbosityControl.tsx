import type { ChatVerbosity } from '@podium/client-core/viewmodels'
import { CHAT_VERBOSITIES, chatVerbosityHint } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/** The three modes, labelled for a 10px mono strip. */
const LABEL: Record<ChatVerbosity, string> = {
  summary: 'sum',
  normal: 'norm',
  verbose: 'all',
}

/**
 * TRANSCRIPT VERBOSITY (POD-376) — how much of the run the feed renders.
 *
 * A three-segment strip rather than a dropdown: there are exactly three values,
 * they are ordered (less → more), and the ordering is the affordance — you read
 * your current density off the strip's position without opening anything. The
 * filled segment is the current one, which is the same grammar the Chat/Native
 * mode switch uses one row above.
 *
 * Deliberately quiet. This sits above every conversation, and a control the
 * reader touches once a week must not compete with the conversation itself.
 */
export function VerbosityControl({
  value,
  onChange,
  /** True while a search query is overriding `summary` — the strip says so
   *  rather than silently showing a setting that isn't in effect. */
  overridden = false,
}: {
  value: ChatVerbosity
  onChange: (v: ChatVerbosity) => void
  overridden?: boolean
}): JSX.Element {
  return (
    <div
      className="verbosity"
      role="radiogroup"
      aria-label="Transcript detail"
      data-testid="verbosity-control"
      data-overridden={overridden ? 'true' : undefined}
      title={
        overridden
          ? 'Showing everything while you search — your Summary setting resumes when you clear the query'
          : undefined
      }
    >
      {CHAT_VERBOSITIES.map((v) => (
        <button
          data-pressable
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={cn('verbosity-seg', value === v && 'verbosity-seg--on')}
          title={chatVerbosityHint(v)}
          onClick={() => onChange(v)}
        >
          {LABEL[v]}
        </button>
      ))}
    </div>
  )
}
