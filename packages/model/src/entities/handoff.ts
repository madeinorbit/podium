/**
 * The handoff manifest — relocated verbatim from `@podium/protocol`'s
 * `messages/handoff.ts` at POD-300, including its containment refinement.
 * Byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json` (which also asserts the
 * refinement still rejects escaping paths after the move).
 *
 * ONLY the manifest moves. The 7 handoff request/result frames
 * (export/chunkRead/importChunk/import, request and result) stay in
 * `@podium/protocol` as frames and import this schema — the manifest is the
 * entity-shaped member of that family, the rest are transport.
 *
 * A handoff bundle is in the PERSONAL set of `docs/multi-user-readiness.md`
 * §3.1.1 and inherits the scoping of the session it packages. Note §3.1.4 M5:
 * handoff to a machine the principal lacks `use` on must be DENIED rather than
 * silently retargeted — that is POD-1079/POD-323's enforcement, not a field on
 * this schema.
 *
 * `sourceMachineId` is a reference to a machine, not a fact about one, so it
 * stays here rather than joining `entities/machine.ts`'s group.
 *
 * POD-643 owns the handoff manifest VOCABULARY decision; this move deliberately
 * changes no member of it — note `agentKind` here is its own two-member literal
 * union (`claude-code` | `codex`), NARROWER than {@link AgentKind}, because only
 * those two harnesses are exportable. That narrowing is preserved exactly.
 *
 * No owner/visibility/grant/instance_id field was added.
 */

import { z } from 'zod'
import { ResumeRef } from './session'

/** Canonical portable session package ([spec:SP-3f7a]). */
export const HandoffManifest = z.object({
  format: z.literal(1),
  sessionId: z.string(),
  agentKind: z.enum(['claude-code', 'codex']),
  resume: ResumeRef,
  transcriptFilename: z.string(),
  transcriptRelativeDir: z.string().optional(),
  repoId: z.string(),
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
  issueId: z.string().optional(),
  sourceMachineId: z.string(),
  exportedAt: z.string(),
})
export type HandoffManifest = z.infer<typeof HandoffManifest>
