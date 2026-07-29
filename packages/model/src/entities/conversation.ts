/**
 * The conversation projection — relocated verbatim from `@podium/protocol`'s
 * `messages/discovery.ts` at POD-300. Field names, order and optionality are
 * unchanged; byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json`.
 *
 * A conversation is a native harness transcript the daemon discovered, keyed by
 * a Podium-stable identity (docs/spec/conversation-registry.md). It belongs to
 * the PERSONAL set of `docs/multi-user-readiness.md` §3.1.1 (private to owner,
 * shareable), NOT to the per-machine group in `entities/machine.ts` — it is a
 * conversation that happens to have been found on a machine, not a fact about
 * the machine.
 *
 * `path` and `sizeBytes` are the exception worth naming: they are
 * machine-local discovery evidence, so a projection that hides a machine's
 * filesystem from a principal without `use` (§3.1.4 M1) must consider them
 * alongside the machine group's `USE` slice even though the entity itself is
 * personal.
 *
 * No owner/visibility/grant/instance_id field was added; both schemas are flat,
 * so those are purely additive later (POD-1075 / POD-1071).
 */

import { z } from 'zod'
import { AgentKind } from './agent'
import { ResumeRef } from './session'

// Discovery payloads on the wire — dates are ISO strings (Date is not JSON-safe).
export const ConversationGit = z.object({
  branch: z.string().optional(),
  sha: z.string().optional(),
  originUrl: z.string().optional(),
})
export type ConversationGit = z.infer<typeof ConversationGit>

export const ConversationSummaryWire = z.object({
  id: z.string(),
  /** Absolute transcript path on the owning machine (discovery evidence). The
   *  registry records it on the conversation's segment so later reads locate the
   *  file without deriving from a mutable cwd. Machine-local; optional. */
  path: z.string().optional(),
  /** Podium-generated stable identity (docs/spec/conversation-registry.md). `id`
   *  above is the NATIVE agent session id — evidence, not identity: a resume that
   *  rolls into a new file gets a new `id` but keeps this `podiumId`. Server-
   *  enriched; absent on daemon-originated payloads and for un-indexed rows. */
  podiumId: z.string().optional(),
  agentKind: AgentKind,
  title: z.string().optional(),
  /** Curated display name (user rename via conversations.setMeta). Server-
   *  enriched from the conversations index — never daemon-originated. Display
   *  surfaces let it win over the harness `title`, matching search results. */
  name: z.string().optional(),
  /** Curated work summary (command center / work-LLM). Server-enriched. */
  summary: z.string().optional(),
  projectPath: z.string().optional(),
  parentConversationId: z.string().optional(),
  statusHint: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  /** Byte size of `path` at scan time — the transcript mirror's dirty signal:
   *  the server enqueues a pull only when this differs from its mirrored cursor,
   *  so a fully-mirrored fleet costs zero mirror round trips per scan/attach. */
  sizeBytes: z.number().int().nonnegative().optional(),
  git: ConversationGit.optional(),
  resume: ResumeRef.optional(),
  providerId: z.string(),
})
export type ConversationSummaryWire = z.infer<typeof ConversationSummaryWire>

export const ConversationDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  providerId: z.string().optional(),
  root: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
})
export type ConversationDiagnosticWire = z.infer<typeof ConversationDiagnosticWire>
