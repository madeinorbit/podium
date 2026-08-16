/**
 * THE ORIGIN BLOCK — where this task came from, whose it is, and who it is for.
 * The last band of the rail, read once and rarely.
 *
 * POD-1163 gave it the attribution pair and took away its raw vocabulary. The
 * pair used to sit MID-DOCUMENT, above the agent panel, as `Published by
 * user:sole · for user:sole` — a line of field names in the middle of the
 * reading column, saying the same id twice on the ordinary row. Provenance is
 * sidebar-tail information (it is where Linear keeps "created by"), and it is
 * information a reader consumes in words, not in enum members. Both halves of
 * that are fixed here: the block moved to the bottom of the rail, and every
 * value it shows is now a sentence produced by `./issue-provenance.ts`.
 *
 * WHAT IT NO LONGER SHOWS. `Created` and `Updated` are gone from this block —
 * the dossier line directly under the title already carries both, with the same
 * absolute timestamps in `title`, and a rail that repeats the page's own
 * subtitle is a rail with a fact in two homes. The rule the rest of the page
 * runs on (one fact, one home) applies to provenance too.
 *
 * STILL READ-ONLY, STILL NEVER DEFAULTED. Per the ADR 1 amendment (POD-1071)
 * owner and visibility are normative columns and are DISPLAYED here, with no
 * control to change either — per-feature sharing UX is deliberately deferred,
 * and inventing a share affordance would settle a question the doc leaves open.
 * `visibility`, `owner` and `createdBy` are PROJECTION fields an older row may
 * not carry, and an absent value renders as no row at all rather than as a
 * default. "Private" printed over a row that never said so is a claim the
 * server did not make, and on a visibility field that is the worst place to
 * guess.
 *
 * STRUCTURALLY ABLE TO GAIN A SHARE ENTRY, still: the rows are a DATA list
 * ({@link ABOUT_ROWS}) rendered by one component, so a `Shared with` line later
 * is one entry plus its accessor, with no call-site change anywhere.
 */

import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { SectionHeading } from './chrome'
import {
  AUDIENCE_PHRASE,
  AUDIENCE_TITLE,
  createdByPhrase,
  createdByTitle,
  humanizeActorId,
  ORIGIN_PHRASE,
  phraseOr,
  VISIBILITY_PHRASE,
} from './issue-provenance'
import { PropertyRow } from './property-chrome'

/** One Origin line: a label, the sentence to show, and an optional hover title.
 *  Returning an empty string means "this row has nothing to say" and the row is
 *  dropped — the absent-vs-default rule in the module note. */
interface AboutRowSpec {
  readonly label: string
  readonly value: (issue: IssueViewModel) => string
  readonly title?: (issue: IssueViewModel) => string | undefined
  readonly testId?: string
}

/**
 * The Origin rows, in the order the questions get asked: who made this, who is
 * it for, whose is it, who can see it.
 *
 * `Created by` reads the stamped pair when the projection carries one and falls
 * back to `origin` when it does not. Those are two different fields answering
 * one question at two fidelities, and each is rendered from what it actually
 * says — the fallback names no id, because `origin` carries none.
 */
export const ABOUT_ROWS: readonly AboutRowSpec[] = [
  {
    label: 'Created by',
    testId: 'about-created-by',
    value: (issue) =>
      issue.createdBy ? createdByPhrase(issue.createdBy) : phraseOr(ORIGIN_PHRASE, issue.origin),
    title: (issue) =>
      issue.createdBy
        ? createdByTitle(issue.createdBy)
        : 'This row predates per-write attribution, so only its coarse origin is known.',
  },
  {
    label: 'Written for',
    testId: 'about-audience',
    value: (issue) => phraseOr(AUDIENCE_PHRASE, issue.audience),
    title: (issue) => AUDIENCE_TITLE[issue.audience],
  },
  {
    label: 'Owner',
    testId: 'about-owner',
    value: (issue) => (issue.owner ? humanizeActorId(issue.owner) : ''),
    title: (issue) =>
      issue.owner
        ? `The one person this issue belongs to (ADR 9 D2): ${issue.owner}. Read-only here.`
        : undefined,
  },
  {
    label: 'Visibility',
    testId: 'about-visibility',
    value: (issue) => phraseOr(VISIBILITY_PHRASE, issue.visibility),
    title: (issue) =>
      issue.visibility === 'personal'
        ? 'Personal class — private to its owner unless explicitly shared'
        : 'The ADR 9 D3 visibility class this row belongs to',
  },
]

export function IssueAbout({ issue }: { issue: IssueViewModel }): JSX.Element {
  return (
    <section className="flex flex-col gap-2" data-testid="issue-about">
      <SectionHeading>Origin</SectionHeading>
      {/* One `PropertyRow`, exactly like the editable properties at the top of
          the rail — so provenance values land on the SAME 104px value column
          the pickers do. This block used to run its own 80px label column, a
          4px offset that made the rail's last band look hand-placed. */}
      <div className="flex flex-col">
        {ABOUT_ROWS.map((row) => (
          <AboutRow
            key={row.label}
            label={row.label}
            value={row.value(issue)}
            title={row.title?.(issue)}
            testId={row.testId}
          />
        ))}
      </div>
    </section>
  )
}

/** One label/value line in the Origin block; empty values render nothing. */
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
    <PropertyRow label={label}>
      <span
        className="block truncate text-[13px] text-muted-foreground"
        title={title}
        data-testid={testId}
      >
        {value}
      </span>
    </PropertyRow>
  )
}
