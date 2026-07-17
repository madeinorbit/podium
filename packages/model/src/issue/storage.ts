import { z } from 'zod'
import { issueDurableShape } from './fields'

/**
 * **R3 — the Issue storage representation** [ADR 4 D2]: the physical row encoding.
 * Meanings still come from the vocabulary (this is `issueDurableShape` plus a
 * short, explicit override list); only the ENCODING is local. Per D6 the server's
 * physical DDL is authored with drizzle-kit [spec:SP-4428] — that is the column
 * authoring tool, not the semantic vocabulary, and this type is the bridge
 * between the two.
 *
 * Keys mirror today's `IssueRow` (`apps/server/src/store/types.ts`) one-to-one so
 * POD-796 can swap the types mechanically.
 */

/**
 * The COMPLETE set of places the row encoding differs from the durable aggregate.
 * Everything not listed here is byte-identical to R1 — that is what makes this
 * list, rather than a 53-key restatement, the honest description of R3.
 */
export const issueStorageOverrides = {
  /**
   * THE JSON-column split — the Issue's analogue of `SessionRow`'s
   * `originKind`/`conversationId`/`resumeKind`/`resumeValue` vs `SessionMeta`'s
   * structured `origin`/`resume` (ADR 4 §4.1's worked example). The panel is a
   * structured value in R1/R4 and a JSON TEXT column in R3. `toStorage`/
   * `fromStorage` own that bijection; nothing else may JSON.parse this column.
   */
  panel: z.string().nullable(),

  /**
   * Enum-valued TEXT columns, widened exactly as `IssueRow` widens them today.
   * The widening is honest — sqlite hands back a string — and the narrowing is
   * `fromStorage`'s job.
   *
   * This is a real IMPROVEMENT over today's serializer, which narrows with a
   * blind `row.stage as IssueWire['stage']` cast: an unrecognised stored value
   * currently flows onto the wire mislabelled as a valid stage. `fromStorage`
   * parses instead, so an unknown value is refused at the boundary rather than
   * silently propagated.
   */
  stage: z.string(),
  type: z.string(),
  origin: z.string(),
  audience: z.string(),
} as const

/**
 * DIVERGENCE from today's `IssueRow`, recorded deliberately: `IssueRow` marks
 * `origin`, `audience`, `draft`, `repoId`, `machineId`, `deletedAt`, `readAt`,
 * `panel`, `color`, `humanQuestionOptions`, `humanQuestionAskedBy` and
 * `humanQuestionAskedAt` OPTIONAL, each with the same comment — "Optional so
 * pre-existing row literals stay valid". That is a concession to test/ingest
 * literals, not a statement about the data: every one of those keys is written on
 * every real write path.
 *
 * The model does not inherit the concession. Here they are required-and-nullable,
 * which is the actual shape of the column. At cutover this surfaces as a compile
 * error at each row literal that omits one — which is precisely ADR 4 D3.3's
 * intended behaviour ("propagates to every representation … **or fails
 * compilation** where inclusion is a deliberate decision"), and cheap to fix.
 */
export const IssueStorageRow = z.object({
  ...issueDurableShape,
  ...issueStorageOverrides,
})
export type IssueStorageRow = z.infer<typeof IssueStorageRow>
