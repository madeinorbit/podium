import { issueObserver as observer } from './issue-observer'
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
 * SHARED TASKS (POD-6295, design §2.2). Every active member reads every task,
 * so the block says `Visible to all members` as a note and offers no sharing
 * control: there is nothing to share. The owner is the task's Assignee, shown
 * with its reassign control at the top of the rail, so it has no row here.
 * People are named by their member display names, never by a raw member id.
 * Collaborators are the members who started or joined the task.
 *
 * `createdBy` is a PROJECTION field an older row may not carry, and an absent
 * value renders as the coarse origin, never as an invented name.
 */

import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { SectionHeading } from './chrome'
import {
  AUDIENCE_PHRASE,
  AUDIENCE_TITLE,
  createdByPhrase,
  createdByTitle,
  type MemberNamer,
  ORIGIN_PHRASE,
  personName,
  phraseOr,
  TASK_VISIBILITY_NOTE,
} from './issue-provenance'
import { PropertyRow } from './property-chrome'

/** What the rows read beside the task: member names and the collaborators. */
export interface AboutContext {
  readonly nameOf?: MemberNamer
  /** The collaborators' member ids, earliest first (POD-6290). */
  readonly collaborators?: readonly string[]
}

/** One Origin line: a label, the sentence to show, and an optional hover title.
 *  Returning an empty string means "this row has nothing to say" and the row is
 *  dropped — the absent-vs-default rule in the module note. */
interface AboutRowSpec {
  readonly label: string
  readonly value: (issue: IssueViewModel, about: AboutContext) => string
  readonly title?: (issue: IssueViewModel) => string | undefined
  readonly testId?: string
}

/**
 * The Origin rows, in the order the questions get asked: who made this, who is
 * it for, who else is on it, who can see it.
 *
 * `Created by` reads the stamped pair when the projection carries one and falls
 * back to `origin` when it does not. Those are two different fields answering
 * one question at two fidelities, and each is rendered from what it actually
 * says — the fallback names no id, because `origin` carries none. An agent's
 * line names the human it worked for.
 */
export const ABOUT_ROWS: readonly AboutRowSpec[] = [
  {
    label: 'Created by',
    testId: 'about-created-by',
    value: (issue, about) =>
      issue.createdBy
        ? createdByPhrase(issue.createdBy, about.nameOf)
        : phraseOr(ORIGIN_PHRASE, issue.intentOrigin),
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
    label: 'Collaborators',
    testId: 'about-collaborators',
    value: (_issue, about) =>
      (about.collaborators ?? []).map((id) => personName(id, about.nameOf)).join(', '),
    title: () => 'Members who started or joined work on this task',
  },
  {
    label: 'Visibility',
    testId: 'about-visibility',
    value: () => TASK_VISIBILITY_NOTE,
    title: () => 'Every member of this Podium can read and edit this task',
  },
]

export const IssueAbout = observer(function IssueAbout({
  issue,
  about = {},
}: {
  issue: IssueViewModel
  about?: AboutContext
}): JSX.Element {
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
            value={row.value(issue, about)}
            title={row.title?.(issue)}
            testId={row.testId}
          />
        ))}
      </div>
    </section>
  )
})

/** One label/value line in the Origin block; empty values render nothing. */
const AboutRow = observer(function AboutRow({
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
})
