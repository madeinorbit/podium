/**
 * THE NEEDS-HUMAN BANNER — a question that belongs to a PERSON (POD-646).
 *
 * `humanQuestionAskedBy` is server-authoritative precisely so "did a person or
 * an agent ask this?" stays answerable (`entities/issue.ts` note 2), and under
 * docs/multi-user-readiness.md §3.1.6 S3 attention routing is per-user by
 * construction — the question reaches ITS human, not a shared operator inbox.
 * So this banner does two things it did not do before the port:
 *
 *  1. It RENDERS whose attention is being asked, from the server's own
 *     `asked.attribution` pair — the asking actor and the human that actor works
 *     for. Not from a session lookup, not from the row's assignee.
 *  2. It still does not let the CLIENT assert the answering identity. Resolving
 *     sends `commands.resolveNeedsHuman`, whose payload is the issue id and
 *     nothing else; the authority stamps who answered from the transport. There
 *     is deliberately no "answering as…" control here, and adding one would be
 *     the client asserting identity that ADR 3 D7 makes the server's.
 *
 * The legacy flat field (`humanQuestionAskedBy`, a bare SessionId) is still
 * shown when the nested pair is absent — an older row genuinely knows only the
 * actor half, and showing one honest half beats fabricating the other.
 */
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import type { IssuePageCommands } from '../issue-page-commands'
import { AttributionPair } from './AttributionPair'

export function NeedsHumanBanner({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element | null {
  if (!issue.needsHuman) return null
  const asked = issue.asked
  return (
    <div
      className="mb-4 flex flex-col gap-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3"
      data-testid="needs-human"
    >
      <p className="font-medium text-[12px] text-amber-600 uppercase tracking-wide dark:text-amber-400">
        Needs human
      </p>
      <p className="break-words text-[13px] text-foreground">
        {asked?.question || issue.humanQuestion || 'Needs a human decision'}
      </p>
      <NeedsHumanAsker issue={issue} />
      <Button
        type="button"
        size="sm"
        className="w-fit"
        disabled={busy}
        onClick={commands.resolveNeedsHuman}
      >
        Resolve
      </Button>
    </div>
  )
}

/** Who asked, and for whom — server fields only. */
function NeedsHumanAsker({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  const asked = issue.asked
  if (asked?.attribution) {
    return (
      <p className="flex flex-wrap items-baseline gap-1 text-[11px] text-muted-foreground">
        <span>Asked by</span>
        <AttributionPair attribution={asked.attribution} />
      </p>
    )
  }
  const legacyAsker = asked?.by ?? issue.humanQuestionAskedBy
  if (!legacyAsker) return null
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="needs-human-asker-legacy">
      Asked by session <span className="font-mono">{legacyAsker}</span>
    </p>
  )
}
