import { z } from 'zod'
import { issueDurableShape } from './fields'

/**
 * **R1 — the canonical durable Issue aggregate** [ADR 4 D2]: domain truth, the
 * thing the Authority revises and the Replica materializes. Composed wholly from
 * the field groups in `./fields.ts`; it declares no field of its own.
 *
 * ## What is deliberately NOT in here
 *
 * **Server-derived read fields** (D3.6 — "pure functions over durable (+ live
 * inputs where needed) … not a second write path"): `ready`, `blocked`,
 * `deferred`, `unread`, `displayRef`, `prefix`, `childCount`, `childDoneCount`,
 * `commentCount`, `sessionSummary`. The deleted session-embedding `IssueWire` carried all of them; none
 * is durable truth, so none is an aggregate member. Where each one goes instead
 * is argued in `./wire.ts`.
 *
 * **Provenance** (D3.8): `viaHub`, `upstreamStale`, `pendingSync` are on
 * `IssueWire` today and are NOT entity payload — they belong to a
 * `ReplicatedEnvelope<T>` (POD-304). "Entity field schemas become
 * provenance-free."
 *
 * **Relations**: `labels`, `deps`, `dependents`, `comments`. These live in their
 * own tables (`issue_labels`, `issue_deps`, `issue_comments`) and are not columns
 * of `IssueRow`. Keeping them out is what lets `toStorage`/`fromStorage` be a
 * true bijection with a single row rather than a multi-table unit of work. They
 * are out of this Phase-1 slice; POD-795/POD-796 decide whether each becomes its
 * own replicated entity keyed by `IssueId` (D7.1) or a replica-side view (D7.3).
 * `dependents` is settled either way: it is the REVERSE index of `deps` and can
 * only ever be replica-side.
 */
export const Issue = z.object(issueDurableShape)
export type Issue = z.infer<typeof Issue>
