import {
  asIssueId,
  asMutationId,
  asSessionId,
  type IssueId,
  type MutationId,
  type SessionId,
} from '@podium/model'
import { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import type { IssueAgentKind } from './agent-models'
import { issueAgentKind } from './agent-models'
import type { UiState } from './ui-state'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from './ui-state'

/** The existing composer chip, shared so a draft owns it across screen lifetimes. */
export interface ComposerAttachment {
  id: string
  name: string
  size?: number
  /** Local preview URI or object URL; empty for files without a preview. */
  previewUri: string
  /** Present only when the upload already reached the agent's machine. */
  path?: string
  /** A held upload is sent by ref, without uploading the file again. */
  ref?: RuntimeAttachmentRef
  state: 'uploading' | 'ready' | 'failed'
  error?: string
}

export type FirstTaskDraft = {
  repoPath: string
  machineId: string
  agent: IssueAgentKind | ''
  model: string
  effort: string
  /** Explicit Auto is a draft choice too; untouched Auto may inherit the last launch. */
  launchPickTouched?: boolean
  title: string
  description: string
  /** Distinguishes current draft-session launches from persisted pre-POD-1838
   * named-issue retries, which must finish through their original mutation. */
  launchKind: 'draft' | 'issue' | ''
  /** Set once the tracked task exists; retries start this issue instead of creating another. */
  pendingIssueId: IssueId | ''
  /** Reserved optimistic identities survive an ambiguous create response, so a
   * retry cannot mint a duplicate if server truth arrives late. */
  createIssueId: IssueId | ''
  createSessionId: SessionId | ''
  createMutationId: MutationId | ''
  startMutationId: MutationId | ''
  /** Uploaded paths already captured into the in-flight task brief. */
  attachmentPaths: string[]
  /** Held uploads and their chips survive optimistic navigation and launch failure. */
  attachments: ComposerAttachment[]
  /** Survives the optimistic workspace being removed so the remounted composer
   * can explain why the saved request returned. */
  launchError: string
}

export const EMPTY_FIRST_TASK_DRAFT: FirstTaskDraft = {
  repoPath: '',
  machineId: '',
  agent: '',
  model: 'auto',
  effort: 'auto',
  launchPickTouched: false,
  title: '',
  description: '',
  launchKind: '',
  pendingIssueId: '',
  createIssueId: '',
  createSessionId: '',
  createMutationId: '',
  startMutationId: '',
  attachmentPaths: [],
  attachments: [],
  launchError: '',
}

export function readFirstTaskDraft(raw: string | null): FirstTaskDraft {
  if (!raw) return EMPTY_FIRST_TASK_DRAFT
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof FirstTaskDraft, unknown>>
    return {
      repoPath: typeof value.repoPath === 'string' ? value.repoPath : '',
      machineId: typeof value.machineId === 'string' ? value.machineId : '',
      agent: typeof value.agent === 'string' ? (issueAgentKind(value.agent) ?? '') : '',
      model: typeof value.model === 'string' && value.model ? value.model : 'auto',
      effort: typeof value.effort === 'string' && value.effort ? value.effort : 'auto',
      launchPickTouched:
        value.launchPickTouched === true ||
        (typeof value.model === 'string' && Boolean(value.model) && value.model !== 'auto') ||
        (typeof value.effort === 'string' && Boolean(value.effort) && value.effort !== 'auto'),
      title: typeof value.title === 'string' ? value.title : '',
      description: typeof value.description === 'string' ? value.description : '',
      launchKind:
        value.launchKind === 'draft' || value.launchKind === 'issue' ? value.launchKind : '',
      pendingIssueId:
        typeof value.pendingIssueId === 'string' && value.pendingIssueId
          ? asIssueId(value.pendingIssueId)
          : '',
      createIssueId:
        typeof value.createIssueId === 'string' && value.createIssueId
          ? asIssueId(value.createIssueId)
          : '',
      createSessionId:
        typeof value.createSessionId === 'string' && value.createSessionId
          ? asSessionId(value.createSessionId)
          : '',
      createMutationId:
        typeof value.createMutationId === 'string' && value.createMutationId
          ? asMutationId(value.createMutationId)
          : '',
      startMutationId:
        typeof value.startMutationId === 'string' && value.startMutationId
          ? asMutationId(value.startMutationId)
          : '',
      attachmentPaths: Array.isArray(value.attachmentPaths)
        ? value.attachmentPaths.filter((path): path is string => typeof path === 'string')
        : [],
      attachments: boundedAttachmentPreviews(readAttachments(value.attachments)),
      launchError: typeof value.launchError === 'string' ? value.launchError : '',
    }
  } catch {
    return EMPTY_FIRST_TASK_DRAFT
  }
}

function readAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row): ComposerAttachment[] => {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !row.id ||
      typeof row.name !== 'string' ||
      typeof row.previewUri !== 'string' ||
      !['uploading', 'ready', 'failed'].includes(row.state)
    )
      return []
    const ref = RuntimeAttachmentRef.safeParse(row.ref)
    const path = typeof row.path === 'string' && row.path ? row.path : undefined
    if (row.state === 'ready' && !path && !ref.success) return []
    return [
      {
        id: row.id,
        name: row.name,
        previewUri: row.previewUri,
        state: row.state,
        ...(typeof row.size === 'number' ? { size: row.size } : {}),
        ...(path ? { path } : {}),
        ...(ref.success ? { ref: ref.data } : {}),
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
      },
    ]
  })
}

/** Inline image bytes share one small draft budget; refs and file URIs do not. */
function boundedAttachmentPreviews(attachments: ComposerAttachment[]): ComposerAttachment[] {
  let remaining = 200 * 1024
  return attachments.map((attachment) => {
    if (!attachment.previewUri.startsWith('data:')) return attachment
    if (attachment.previewUri.length > remaining) return { ...attachment, previewUri: '' }
    remaining -= attachment.previewUri.length
    return attachment
  })
}

/** Module-level so `usePersistedUiState` gets a stable `serialize` identity. */
export function serializeFirstTaskDraft(draft: FirstTaskDraft): string {
  return JSON.stringify({ ...draft, attachments: boundedAttachmentPreviews(draft.attachments) })
}

/** Cold storage has no upload promises. Live draft reads must leave them alone. */
export function interruptFirstTaskDraftUploads(raw: string | null): string | null {
  const draft = readFirstTaskDraft(raw)
  if (!draft.attachments.some((attachment) => attachment.state === 'uploading')) return raw
  return serializeFirstTaskDraft({
    ...draft,
    attachments: draft.attachments.map((attachment) =>
      attachment.state === 'uploading'
        ? {
            ...attachment,
            state: 'failed',
            error: 'Upload interrupted. Remove and attach the file again.',
          }
        : attachment,
    ),
  })
}

export function persistFirstTaskDraft(uiState: Pick<UiState, 'set'>, draft: FirstTaskDraft): void {
  uiState.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, serializeFirstTaskDraft(draft))
}

export function clearFirstTaskDraft(uiState: Pick<UiState, 'set'>): void {
  uiState.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, null)
}

/** Attachment edits use the current checkpoint, including after an async upload. */
export function updateFirstTaskDraftAttachments(
  uiState: Pick<UiState, 'get' | 'set'>,
  change: (current: ComposerAttachment[]) => ComposerAttachment[],
): ComposerAttachment[] {
  const current = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
  const attachments = change(current.attachments)
  // A removed chip's late upload must not invalidate a newer launch reservation.
  if (
    attachments.length === current.attachments.length &&
    attachments.every((attachment, index) => attachment === current.attachments[index])
  )
    return current.attachments
  persistFirstTaskDraft(uiState, { ...withoutCreateReservation(current), attachments })
  return attachments
}

export function withoutCreateReservation(draft: FirstTaskDraft): FirstTaskDraft {
  return {
    ...draft,
    launchKind: '',
    createIssueId: '',
    createSessionId: '',
    createMutationId: '',
    attachmentPaths: [],
    launchError: '',
  }
}
