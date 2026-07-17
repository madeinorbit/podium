import { z } from 'zod'

/**
 * The branded entity id family — the canonical home [ADR 4 D3.5: "Ids branded at
 * the vocabulary boundary"]. Each id is a zod-branded string: structurally a
 * plain string on the wire and in sqlite, but nominally distinct in the type
 * system, so a SessionId cannot silently flow into a MachineId parameter.
 *
 * Two ways in, matching the established convention:
 *   - `IssueId.parse(s)`  — validating boundary (wire / db input);
 *   - `asIssueId(s)`      — plain cast where the string is already trusted
 *                           (it came out of our own store or a parsed envelope).
 *
 * ## Relationship to `@podium/protocol`'s `ids.ts` (deliberate duplication)
 *
 * `packages/protocol/src/ids.ts` [spec:SP-3fe2] declares the same brands today.
 * Model is L0 and imports NO other @podium package (ADR 8 layer map), so it
 * cannot import them; and protocol is NOT edited to re-export from here, because
 * moving entity schemas out of protocol is the POD-300 / POD-796 cutover's job,
 * not this slice's.
 *
 * The duplication is safe and temporary BY CONSTRUCTION: a zod brand is a purely
 * structural type-level tag (`string & z.BRAND<'IssueId'>`). These declarations
 * use byte-identical brand tags and an identical base schema (`z.string().min(1)`)
 * to protocol's, so `@podium/model`'s `IssueId` and `@podium/protocol`'s `IssueId`
 * are the SAME type and are mutually assignable across the package boundary. The
 * cutover therefore only has to redirect imports — no value or type has to change
 * shape.
 *
 * That equivalence is NOT pinned by a test, and deliberately so: any test proving
 * it would have to import `@podium/protocol`, and an L0→L1 edge is a
 * `manifest-layer` violation that `checkManifestEdge` does not exempt for test
 * files ("an upward edge from a package's own tests means the package can no
 * longer be built or tested without a higher layer"). The pin therefore has to
 * live in a workspace that already depends on both — the same place the existing
 * `IssueColor` drift test already sits (apps/server) — and is tracked as a
 * follow-up rather than smuggled in here. Until it exists, the brand tags and
 * base schemas above must be kept identical to protocol's BY HAND.
 */

export const MachineId = z.string().min(1).brand<'MachineId'>()
export type MachineId = z.infer<typeof MachineId>
export const asMachineId = (s: string): MachineId => s as MachineId

export const SessionId = z.string().min(1).brand<'SessionId'>()
export type SessionId = z.infer<typeof SessionId>
export const asSessionId = (s: string): SessionId => s as SessionId

export const IssueId = z.string().min(1).brand<'IssueId'>()
export type IssueId = z.infer<typeof IssueId>
export const asIssueId = (s: string): IssueId => s as IssueId

export const RepoId = z.string().min(1).brand<'RepoId'>()
export type RepoId = z.infer<typeof RepoId>
export const asRepoId = (s: string): RepoId => s as RepoId
