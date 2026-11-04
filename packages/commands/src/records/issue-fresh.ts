/**
 * WHAT A NEW ISSUE LOOKS LIKE (POD-6400), for `ISSUE_RECORD` in `./kinds.ts`.
 *
 * The server's issue create (`apps/server/src/modules/issues/service/crud.ts`)
 * reads these constants instead of spelling its own, and the creating device
 * paints them, so the row a create paints is the row the server stores on
 * every cell except the pending ones. The server's records test holds the two
 * equal on a real create.
 */

import { actorUser, asUserId } from '@podium/model'
import type { FreshContext, FreshRecord } from './fresh'

/** What a create that leaves the field out stores. */
export const ISSUE_FIELD_DEFAULTS = {
  description: '',
  priority: 2,
  type: 'task',
} as const

/** The cells every new issue starts with. */
export const ISSUE_FRESH_CELLS = {
  stage: 'backlog',
  archived: false,
  labels: [] as readonly string[],
  blockedByNotes: [] as readonly string[],
  needsHuman: false,
  // The issue stores picks only (POD-6133): `auto` until someone picks.
  defaultAgent: 'auto',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  visibility: 'personal',
  intentOrigin: 'human',
  audience: 'human',
  isDraftVessel: false,
} as const

/** The `seq` a device paints before the server numbers the issue. The server's
 *  numbers start at 1, so 0 is never a real one: a reader shows it as pending. */
export const PENDING_ISSUE_SEQ = 0

/** Whether an issue row's number is still the device's placeholder. */
export const issueSeqPending = (row: { readonly seq: number }): boolean =>
  row.seq === PENDING_ISSUE_SEQ

const by = (ctx: FreshContext) => asUserId(ctx.by ?? '')

export const ISSUE_FRESH: FreshRecord = {
  cells: ISSUE_FRESH_CELLS,
  pending: {
    // The server numbers it inside the create (`nextIssueSeq`).
    seq: () => PENDING_ISSUE_SEQ,
    // Resolved from the create's repo path; painted absent until then.
    repoId: () => undefined,
    revision: () => undefined,
    // The repository's base branch, the instance default or the detected one.
    parentBranch: () => '',
    sortKey: () => undefined,
    // The creator's on-behalf-of human, as the server resolves it.
    owner: by,
    createdBy: (ctx) => ({ actor: actorUser(by(ctx)), onBehalfOf: by(ctx) }),
    // The server's clock; the device's queue time until then.
    createdAt: (ctx) => ctx.at,
    updatedAt: (ctx) => ctx.at,
  },
}
