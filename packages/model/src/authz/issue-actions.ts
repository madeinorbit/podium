/**
 * WHAT A TASK READER MAY DO FROM THE TASK PAGE (POD-6295; design §2.2).
 *
 * The page draws a control only where the server says the viewer may use it,
 * so the client never re-derives policy. Every active member edits ordinary
 * task content, restores a revision and comments (D5), and any person may
 * reassign the task to any active member (D2). An agent writes within its
 * subtree, or with `--outside-scope`; it never changes the human assignee
 * (MU-24). A write that would need `--outside-scope` is not offered: the page
 * has no way to confirm one.
 */

import type { AuthDecision } from './issue-authz'

/** The task-level controls the page may draw for one reader. */
export interface IssueAllowedActions {
  /** Change the assignee to another active member. */
  readonly reassign: boolean
  /** Edit the task's content and properties. */
  readonly edit: boolean
  /** Restore a recorded description or brief revision. */
  readonly restore: boolean
  /** Add a comment. */
  readonly comment: boolean
}

/**
 * THE RULE, from the two facts the server holds: the `write` decision for
 * this reader on this task, and whether the reader is a person in person.
 */
export function issueAllowedActions(write: AuthDecision, person: boolean): IssueAllowedActions {
  const edit = write === 'allow'
  return { reassign: edit && person, edit, restore: edit, comment: edit }
}
