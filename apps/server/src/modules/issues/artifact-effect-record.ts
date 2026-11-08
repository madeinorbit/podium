/**
 * WHAT AN ARTIFACT EFFECT RECORD HOLDS, AND THE ENTRY POINT'S CHECK OF ITS
 * COMMIT (POD-6420). A leaf beside `artifact-effects.ts` so the panelApply
 * handler (`registry.ts`) reads it without importing the executors, which
 * import the command table.
 */

import { createHash } from 'node:crypto'
import { type ArtifactId, asArtifactId, type IssueProjection, type MutationId } from '@podium/model'
import { z } from 'zod'
import { attributionOf, type CommandPrincipal } from '../../command-principal'
import type { EffectRow } from '../../store/effects'
import type { IssueCaller } from './command-ctx'
import type { ArtifactPanelEntry } from './service/crud'
import { IssueRefusal } from './service/refusal'

export const ISSUE_ARTIFACT_EFFECT_KIND = {
  add: 'issue.artifactAdd',
  publish: 'issue.artifactPublish',
  remove: 'issue.artifactRemove',
} as const

export type IssueArtifactAction = keyof typeof ISSUE_ARTIFACT_EFFECT_KIND

export const KINDS: ReadonlySet<string> = new Set(Object.values(ISSUE_ARTIFACT_EFFECT_KIND))

// ---------------------------------------------------------------------------
// The record inputs: references only.
// ---------------------------------------------------------------------------

export const IssueArtifactAddInput = z
  .object({
    path: z.string().min(1),
    title: z.string().optional(),
    extraPaths: z.array(z.string()).optional(),
    terminalEvidence: z.boolean().optional(),
    sourceRoot: z.string().optional(),
  })
  .strict()
export type IssueArtifactAddInput = z.infer<typeof IssueArtifactAddInput>

export const IssueArtifactPublishInput = z.object({ uploadId: z.string().uuid() }).strict()
export type IssueArtifactPublishInput = z.infer<typeof IssueArtifactPublishInput>

export const IssueArtifactRemoveInput = z
  .object({ path: z.string(), artifactId: z.string().optional() })
  .strict()
export type IssueArtifactRemoveInput = z.infer<typeof IssueArtifactRemoveInput>

/** What an add or publish stages on its record before the commit: the entry. */
export interface StagedEntry {
  readonly entry: ArtifactPanelEntry
  /** The snapshot the path held before; deleted once the commit lands. */
  readonly replaces?: ArtifactId
}

/** The snapshot id a record's add or publish stores under. */
export function artifactIdOfEffect(recordId: string): ArtifactId {
  return asArtifactId(createHash('sha256').update(recordId).digest('hex').slice(0, 12))
}

// ---------------------------------------------------------------------------
// The entry point's commit: the entry comes from the record, not the call.
// ---------------------------------------------------------------------------

/** The panel op an artifact effect's commit writes, read from its record. */
export type ArtifactEffectCommit =
  | { op: 'artifact-add'; entry: ArtifactPanelEntry }
  | { op: 'artifact-remove'; path: string; artifactId?: ArtifactId }

/**
 * The panel change a `panelApply` call carrying `effectId` may commit, or a
 * refusal: the record must be this op's kind, on this issue, running, written
 * by this caller, and (for an add) have staged its own snapshot.
 */
export function artifactEffectCommitOf(
  record: EffectRow | undefined,
  call: { issueId: string; op: string; principal: CommandPrincipal | undefined },
): ArtifactEffectCommit {
  const refuse = (): never => {
    throw new IssueRefusal('this artifact change does not belong to a running artifact effect')
  }
  if (record === undefined || record.deletedAt !== undefined || !KINDS.has(record.kind)) refuse()
  const row = record as EffectRow
  if (row.status !== 'running' || row.target.kind !== 'issue' || row.target.id !== call.issueId)
    refuse()
  if (call.principal === undefined || attributionOf(call.principal).actor !== row.actor) refuse()
  if (row.kind === ISSUE_ARTIFACT_EFFECT_KIND.remove) {
    if (call.op !== 'artifact-remove') refuse()
    const input = IssueArtifactRemoveInput.parse(row.input)
    return {
      op: 'artifact-remove',
      path: input.path,
      ...(input.artifactId !== undefined ? { artifactId: asArtifactId(input.artifactId) } : {}),
    }
  }
  if (call.op !== 'artifact-add') refuse()
  const staged = row.result as StagedEntry | undefined
  if (staged?.entry?.artifactId !== artifactIdOfEffect(row.id)) refuse()
  return { op: 'artifact-add', entry: (staged as StagedEntry).entry }
}

/** The port's answer for an upload's byte packet (`begin`, `chunk`, `abort`):
 *  transport into private staging, no record; the handler stages it and writes
 *  no issue (POD-6605). Every other artifact op is a record or a refusal. */
export const ARTIFACT_TRANSPORT: unique symbol = Symbol('issue artifact: byte transport')

/** One `panelApply` artifact call, as the handler parsed it. */
export interface ArtifactCall {
  readonly id: string
  readonly op: 'artifact-add' | 'artifact-upload' | 'artifact-remove'
  readonly path?: string
  readonly title?: string
  readonly extraPaths?: string[]
  readonly terminalEvidence?: boolean
  readonly sourceRoot?: string
  readonly index?: number
  readonly upload?: { readonly action: string; readonly uploadId: string }
  readonly mutationId?: MutationId
}

export interface IssueArtifactEffectPort {
  /** Run one artifact op as an effect record, as this caller; answer the issue as
   *  the old command did, or {@link ARTIFACT_TRANSPORT} for an upload's byte packet. */
  run(caller: IssueCaller, call: ArtifactCall): Promise<IssueProjection | typeof ARTIFACT_TRANSPORT>
  /** One effect record, for the entry point's commit check. */
  record(id: string): Promise<EffectRow | undefined>
}
