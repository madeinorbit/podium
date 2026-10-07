/** The edit draft of an issue form: `draft()` over the issue's editable fields.
 * Import it as `@podium/client-graph/write/draft-of` from the form's screen, so
 * it loads with that screen, never at startup (`scripts/web-bundle-budget.ts`). */
import { type Draft, draft } from '@podium/mobx-helpers'
import type { ModelOf } from '../models'
import { EDITABLE_FIELDS, type EditPatch, type TxId } from './commands'

type IssueObject = ModelOf['issue']

/** The fields one `issues.update` sets. `readAt` is mark-read, its own command
 * (`commandFor` refuses it mixed with others), so it is never a form field. */
export type IssueDraftField = Exclude<keyof EditPatch<'issue'>, 'readAt'>

const ISSUE_DRAFT_FIELDS = (Object.keys(EDITABLE_FIELDS.issue) as (keyof EditPatch<'issue'>)[]).filter(
  (field): field is IssueDraftField => field !== 'readAt',
)

export type IssueDraft = Draft<IssueObject, IssueDraftField, TxId>

/**
 * An edit draft of `issue` for a form (`docs/agents/frontend-data.md`):
 * inputs read and write `d.title`, `d.stage`; untouched fields follow the live
 * issue; `d.submit()` is ONE `issue.update(changes)`, one transaction of the
 * edit log. The write contract checks the values (`commandFor`) at submit.
 */
export function draftOf(issue: IssueObject): IssueDraft {
  return draft(issue, {
    fields: ISSUE_DRAFT_FIELDS,
    save: (changes) => issue.update(changes as EditPatch<'issue'>),
  })
}
