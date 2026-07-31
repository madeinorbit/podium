/**
 * `IssueAggregate` — the canonical R1 issue (POD-365).
 *
 * The issue side is less split than the session side — `issues` (59 columns) and
 * `IssueWire` (78 keys) largely agree — but "largely" is the problem: POD-364
 * catalogued the disagreements, and seventeen representations pick from two
 * shapes neither of which is the authority. This file is the authority.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR ABSENCES THAT MATTER MORE THAN THE MEMBERS
 * ---------------------------------------------------------------------------
 *
 * 1. **`sessions: SessionMeta[]` is not here and must never be added.** It is
 *    THE entity-in-entity embed ADR 4 D7's normalization law deletes:
 *    O(world) per change with one user, O(world × N) with N users each holding a
 *    different slice — and a nested child cannot be independently suppressed
 *    from a scoped feed, which makes de-nesting a PREREQUISITE for scoped feeds
 *    rather than a performance fix. POD-367 replaces it with `sessionIds` or a
 *    replica-side join over the slice.
 *
 * 2. **Per-user state is absent by construction** — `readAt`, `unread`,
 *    `tuckedAt`, `pinned`. They are POD-1076's `(userId, issueId)` rows over the
 *    one `PerUserKey` fragment, and `registry.test.ts` fails if one reappears
 *    here. Note `pinned` is a SECOND pin mechanism beside the `pins` table;
 *    POD-1076 collapses the two (inventory §7.1).
 *
 * 3. **The derived fields are absent** — `ready`, `blocked`, `deferred`,
 *    `childCount`, `childDoneCount`, `commentCount`, `sessionSummary`,
 *    `displayRef`, `prefix`, `repoPath`, `gitState`. They live on
 *    `IssueDerived`, are pure functions over R1 (ADR 4 D3.6), and four of them
 *    are simultaneously D7.4 materialized-entity candidates and inventory L-1
 *    existence leaks once the feed is scoped.
 *
 * 4. **`description` and `notes` are not plain strings.** They are ADR 1
 *    Amendment 1 D12's reserved `op-stream` members and carry
 *    `IssueDocuments`' materialized-value-plus-bounded-tail shape, so that the
 *    day the class is implemented is not also the day the wire shape changes
 *    (inventory §8, ADR 2 D5's retention proof).
 */

import { z } from 'zod'
import { Attribution } from '../fields/attribution'
import { Ownership } from '../fields/ownership'
import {
  IssueAgentDefaults,
  IssueConcurrency,
  IssueCoordination,
  IssueDocuments,
  IssueGraphRefs,
  IssueIdentity,
  IssueIntent,
  IssueLifecycle,
  IssueLinear,
  IssuePanelGroup,
  IssueText,
  IssueTriage,
  IssueWorkspace,
  NeedsHuman,
} from '../fields/issue'

/**
 * The canonical durable issue — inventory §6.4's `Issue` R1 row.
 *
 * Composed with `.extend()` over the named groups for the same reason the
 * session aggregate is: a retyped key list here would be the 18th issue
 * representation rather than the collapse of the other 17 (ADR 4 D3.3).
 */
export const IssueAggregate = IssueIdentity.extend(IssueText.shape)
  .extend(IssueDocuments.shape)
  .extend(IssueLifecycle.shape)
  .extend(IssueTriage.shape)
  .extend(IssueGraphRefs.shape)
  .extend(IssueWorkspace.shape)
  .extend(IssueAgentDefaults.shape)
  .extend(NeedsHuman.shape)
  .extend(IssuePanelGroup.shape)
  .extend(IssueIntent.shape)
  .extend(IssueCoordination.shape)
  .extend(IssueLinear.shape)
  // The authority-assigned expected-revision token [ADR 2 D3] — link 3 of the
  // five-link chain, recovered from main at the POD-1246 catch-up. See
  // `../fields/issue.ts#IssueConcurrency` for why a partial chain is worse than
  // no chain at all.
  .extend(IssueConcurrency.shape)
  .extend(Ownership.shape)
  .extend({
    createdAt: z.string(),
    updatedAt: z.string(),
    /** WHICH PRINCIPAL created this issue (ADR 9 D5 A3). `owner` above is this
     *  pair's `onBehalfOf` under D5 A4, never the agent. Distinct from
     *  `intentOrigin`, which is a ROLE CLASS and answers a different question. */
    createdBy: Attribution,
  })
export type IssueAggregate = z.infer<typeof IssueAggregate>
