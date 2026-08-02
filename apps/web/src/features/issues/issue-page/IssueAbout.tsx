/**
 * THE ABOUT BLOCK — row-level provenance, freshness, and now OWNER + VISIBILITY
 * (POD-646).
 *
 * Per the ADR 1 amendment (POD-1071), owner and visibility are NORMATIVE columns
 * on the ownership matrix, and issues are personal-class and private by default.
 * They are DISPLAYED here and they are READ-ONLY: the doc defers per-feature
 * sharing UX deliberately, so this block shows what the row says and offers no
 * way to change it. Inventing a share control here would settle a question the
 * doc explicitly leaves open.
 *
 * WHAT "STRUCTURALLY ABLE TO GAIN A SHARE ENTRY" MEANS, CONCRETELY. The rows
 * below are a DATA list ({@link ABOUT_ROWS}) rendered by one component, not nine
 * hand-written JSX rows. Adding a `Shared with` entry later is one entry in that
 * array plus its accessor — no restructuring of this file, and no call-site
 * change anywhere that renders it. That is the whole requirement, and it is
 * satisfied by the shape rather than by a promise.
 *
 * `visibility` and `owner` are PROJECTION fields (`Ownership` on the issue
 * aggregate), so an older row may not carry them. An absent value renders as
 * nothing at all rather than as a default — "private" printed over a row that
 * never said so would be a claim the server did not make, and on a visibility
 * field that is the worst possible place to guess.
 */
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { relativeTime } from '@/lib/home'

/** One About line: a label, the value to show, and an optional hover title.
 *  Returning an empty string means "this row has nothing to say" and the row is
 *  dropped — the absent-vs-default rule in the module note. */
interface AboutRowSpec {
  readonly label: string
  readonly value: (issue: IssueViewModel, now: number) => string
  readonly title?: (issue: IssueViewModel) => string | undefined
  readonly testId?: string
}

/**
 * The About rows, in order.
 *
 * Owner and visibility sit at the TOP rather than appended at the bottom: they
 * answer "whose is this, and who can see it", which under private-by-default is
 * the first question about a row, not a footnote to its timestamps.
 */
export const ABOUT_ROWS: readonly AboutRowSpec[] = [
  {
    label: 'Owner',
    testId: 'about-owner',
    value: (issue) => issue.owner ?? '',
    title: () => 'The one person this issue belongs to (ADR 9 D2). Read-only here.',
  },
  {
    label: 'Visibility',
    testId: 'about-visibility',
    value: (issue) => issue.visibility ?? '',
    title: (issue) =>
      issue.visibility === 'personal'
        ? 'Personal — private to its owner unless explicitly shared'
        : 'The ADR 9 D3 visibility class this row belongs to',
  },
  {
    label: 'Created',
    value: (issue, now) => relativeTime(issue.createdAt, now),
    title: (issue) => issue.createdAt,
  },
  {
    label: 'Updated',
    value: (issue, now) => relativeTime(issue.updatedAt, now),
    title: (issue) => issue.updatedAt,
  },
  { label: 'Origin', value: (issue) => issue.origin },
  { label: 'Audience', value: (issue) => issue.audience },
]

export function IssueAbout({ issue }: { issue: IssueViewModel }): JSX.Element {
  const now = Date.now()
  return (
    <section className="flex flex-col gap-0.5 border-border border-t pt-3" data-testid="issue-about">
      {ABOUT_ROWS.map((row) => (
        <AboutRow
          key={row.label}
          label={row.label}
          value={row.value(issue, now)}
          title={row.title?.(issue)}
          testId={row.testId}
        />
      ))}
    </section>
  )
}

/** One muted label/value line in the About block; empty values render nothing. */
function AboutRow({
  label,
  value,
  title,
  testId,
}: {
  label: string
  value: string
  title?: string
  testId?: string
}): JSX.Element | null {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-2 text-[12px]" data-testid={testId}>
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/80" title={title}>
        {value}
      </span>
    </div>
  )
}
