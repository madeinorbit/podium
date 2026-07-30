/**
 * The handoff manifest — representation **R6, portable export** (ADR 4 D2/D4).
 * Relocated verbatim from `@podium/protocol`'s `messages/handoff.ts` at POD-300,
 * including its containment refinement. Byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json` (which also asserts the
 * refinement still rejects escaping paths after the move).
 *
 * ===========================================================================
 * REPRESENTATION ENTRY (POD-368 convention: purpose · why it differs · what it
 * picks). POD-643 owns this vocabulary.
 * ===========================================================================
 *
 * PURPOSE — **portable export.** A manifest is the header of a bundle that
 * LEAVES the live system: written to a file, carried to another machine,
 * accepted by a different server. Nothing about it is a delivery detail, so
 * every fact in it must be durable (this is why `sourceMachineId` and
 * `exportedAt` stay on the entity rather than moving to
 * `provenance/envelope.ts` — see the ownership matrix's `handoff-bundle` row,
 * and `provenance/envelope.test.ts`, which fails anyone who moves them).
 *
 * WHY ITS SEMANTICS GENUINELY DIFFER from the canonical session aggregate —
 * three reasons, none of them "a slightly different field list":
 *
 *   1. It describes a session that is being MOVED, not one that is running.
 *      `headSha` / `snapshotSha` / `snapshotFlattened` / `bundleBase` are facts
 *      about the packaged git state at export time — they have no meaning on a
 *      live session and must not be added to one.
 *   2. It is versioned independently of the wire. `format: 1` is a FILE format:
 *      an old bundle must still parse after the protocol has moved on, which is
 *      not a property any wire projection has or wants.
 *   3. Its `agentKind` is deliberately NARROWER than the shared
 *      {@link AgentKind} — a two-member union (`claude-code` | `codex`),
 *      because only those two harnesses are exportable. Widening it would make
 *      the schema accept a bundle no importer can resume. Recorded as a
 *      DECISION here (POD-364 §6.4 asked for one), not an accident of copying.
 *
 * WHAT IT PICKS from the shared field schemas: session identity
 * (`sessionId`, `agentKind`, `resume`, `title`, `issueId`), the issue-workspace
 * subset (`branch`, `worktreeName`, `worktreeRelativePath`, `cwdSubpath`,
 * `repoId`), and attribution (`exportedAt`, `sourceMachineId`, plus the
 * actor / on-behalf-of pair). Bundle-local and legitimately not shared:
 * `format`, `transcriptFilename`, `transcriptRelativeDir`, `headSha`,
 * `snapshotSha`, `snapshotFlattened`, `bundleBase`.
 *
 * > **COMPOSITION STATUS (POD-643).** The `Pick` set above is DECIDED and is
 * > this file's contract, but it is not yet expressed as code: the shared
 * > session field groups and the single `Attribution` schema are POD-365's, and
 * > forking a second definition here to look composed would defeat the entire
 * > point of POD-302. Until POD-365 lands, these fields stay hand-written and
 * > the key set is LOCKED by `handoff.test.ts` so the list cannot drift further
 * > while it waits. Zero new hand-restated fields were added here.
 *
 * ===========================================================================
 * OWNERSHIP, VISIBILITY AND THE ONE THING THAT MUST NEVER BE IN A BUNDLE
 * ===========================================================================
 *
 * VISIBILITY CLASS — **personal.** A handoff bundle is in the PERSONAL set of
 * `docs/multi-user-readiness.md` §3.1.1 (private to owner, shareable) and
 * inherits the scoping of the session it packages. Its owner is the
 * ON-BEHALF-OF human of whoever minted it, with the minting agent or session as
 * ACTOR (ADR 9 D5 A4). See the matrix row `handoff-bundle` for the full
 * declaration; do not re-derive it here.
 *
 * **`owner` ON A MANIFEST IS PROVENANCE, NEVER AN AUTHORIZATION INPUT.** This
 * is worth stating flatly, because a field literally named `owner` invites
 * exactly the wrong reading on the import path. ADR 3 D7 is absolute: the
 * principal comes from the AUTHENTICATED TRANSPORT, never from payload — and a
 * bundle IS payload, from a machine outside this trust domain. So:
 *
 *   - the manifest's owner records WHO EXPORTED IT, which is a durable fact;
 *   - an imported bundle claiming an owner MUST NOT thereby confer ownership or
 *     visibility on the importing side. The import path decides ownership from
 *     its OWN principal, and a bundle that names someone else's user id is
 *     information, not an instruction.
 *
 * **NO CAPABILITY SNAPSHOT — the load-bearing constraint.** The manifest
 * carries IDENTITY AND PROVENANCE only. It must never serialize what the
 * session was ALLOWED to do: effective rights are its scope intersected with
 * its human's CURRENT rights, resolved live at every apply (ADR 9 D5 A1, ADR 3
 * D8), and a snapshot leaves an unattended agent running with rights its human
 * no longer holds, with no cleanup trigger. The target resolves rights from its
 * transport principal at apply time. Nothing is lost by refusing to copy them:
 * per ADR 9 D5 A5 the agent principal's lifecycle IS `SessionBinding`, which is
 * why delegation survives cross-machine handoff for free. Enforced, not merely
 * documented, by `findCapabilitySnapshotKeys` in `handoff.test.ts`.
 *
 * PER-MACHINE FACTS INHERIT MACHINE SCOPING. `transcriptFilename` /
 * `transcriptRelativeDir`, `worktreeName`, `worktreeRelativePath`,
 * `cwdSubpath`, `bundleBase` and the repo checkout are facts ABOUT A MACHINE;
 * per ADR 9 D3 they inherit that machine's scoping rather than carrying a
 * visibility of their own, so they are NOT classified field by field.
 * `sourceMachineId` is the one exception in kind: it is a REFERENCE to a
 * machine, not a fact about one, which is also why it stays here rather than
 * joining `entities/machine.ts`'s group.
 *
 * ONLY the manifest lives here. The 8 handoff request/result frames — four
 * request/result pairs: export, chunkRead, importChunk, import — stay in
 * `@podium/protocol` as frames and import this schema (ADR 4 D4). The manifest
 * is the entity-shaped member of that family; the rest are transport. (POD-643's
 * brief says "seven"; the file has eight, matching ADR 4 D4's count.)
 *
 * No visibility/grant/instance_id field was added, and ADR 1 D5 stands: this is
 * multi-user, not multi-tenancy.
 */

import { z } from 'zod'
import { IssueIdField, machineIdBlockedOnPOD318, RepoIdField, SessionIdField } from '../ids'
import { ResumeRef } from './session'

/** Canonical portable session package ([spec:SP-3f7a]). */
export const HandoffManifest = z.object({
  format: z.literal(1),
  sessionId: SessionIdField,
  agentKind: z.enum(['claude-code', 'codex']),
  resume: ResumeRef,
  transcriptFilename: z.string(),
  transcriptRelativeDir: z.string().optional(),
  repoId: RepoIdField,
  branch: z.string(),
  headSha: z.string(),
  snapshotSha: z.string().nullable(),
  snapshotFlattened: z.literal(true),
  worktreeName: z.string(),
  /** Repository-relative checkout location, using `/` separators. New exporters
   *  include it when the linked worktree lives below the primary checkout;
   *  older packages omit it and import under `.worktrees/<worktreeName>`.
   *  [spec:SP-3f7a] */
  worktreeRelativePath: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'worktreeRelativePath must stay inside the repository',
    )
    .optional(),
  /** Where the agent sat inside the worktree, relative to its root ([spec:SP-3f7a]).
   *  Absent = the root. The import lands the resumed agent in the equivalent
   *  subdir, or the root when the target tree has no such directory. */
  cwdSubpath: z.string().optional(),
  bundleBase: z.array(z.string()),
  title: z.string().optional(),
  issueId: IssueIdField.optional(),
  /** CARVED OUT of the brand flip (ADR 1 Amendment 2 D16.2): an exporter running
   *  on the bundled local daemon stamps LOCAL_MACHINE_ID = 'local' here, and a
   *  length-only brand would launder that sentinel into a well-typed identity.
   *  POD-318 retires it; this becomes MachineIdField then. */
  sourceMachineId: machineIdBlockedOnPOD318,
  exportedAt: z.string(),
})
export type HandoffManifest = z.infer<typeof HandoffManifest>

/**
 * Why a handoff was refused — the closed set that keeps a fail-closed handoff
 * from reading as a broken one (ADR 9 D6 M5, ADR 1 Am1 D13.7).
 *
 * `use` on a machine — spawn, reattach, attach a PTY, run harness commands,
 * read/write files, take a worktree — is OWNER-ONLY until granted, so a handoff
 * to a machine the principal may not use is DENIED, never silently retargeted.
 * The failure must then say WHICH kind it is: "denied" and "offline" otherwise
 * produce the same empty list, and a user who cannot tell them apart retries
 * forever against a machine that will never accept.
 *
 * The three arms, and the reason there are exactly three:
 *
 *   - `unauthorized` — the principal can `see` the target and it is reachable,
 *     but lacks `use`. Asking again will not help; someone must grant.
 *   - `unreachable` — the principal may use the target; the target is offline.
 *     Retrying later is the correct response.
 *   - `unknown-target` — the FAIL-IDENTICALLY arm, and the one that makes this
 *     union safe. A machine OUTSIDE the principal's `see` set and a machine id
 *     that does not exist must produce the SAME refusal. The other two arms are
 *     distinguishable only INSIDE `see`, where existence is already disclosed;
 *     without this arm the refusal becomes an existence oracle, which is the
 *     §3.1.2 existence-leak class arriving at a concrete site (compare the
 *     same rule on `mailSend`, §3.1.5's consistent-error rule).
 *
 * VOCABULARY ONLY. This issue defines the union and threads it through the
 * handoff result frames so a refusal CAN be expressed; the enforcement that
 * populates it — checking `use` on the target before accepting — belongs to
 * POD-1079 and the handoff work under POD-323 / POD-644, and is handed to them
 * in writing. Nothing here authorizes anything.
 */
export const HandoffRefusalReason = z.enum(['unauthorized', 'unreachable', 'unknown-target'])
export type HandoffRefusalReason = z.infer<typeof HandoffRefusalReason>
