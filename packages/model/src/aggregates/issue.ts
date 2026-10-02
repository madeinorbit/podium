

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
