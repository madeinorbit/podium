import type { UiState } from '@podium/client-core/ui-state'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import {
  asIssueId,
  asMutationId,
  asSessionId,
  type IssueId,
  type MutationId,
  type SessionId,
} from '@podium/model'
import type { IssueAgentKind } from '@/lib/issue-agents'
import { issueAgentKind } from '@/lib/issue-agents'

export type FirstTaskDraft = {
  repoPath: string
  machineId: string
  agent: IssueAgentKind | ''
  model: string
  effort: string
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
  title: '',
  description: '',
  launchKind: '',
  pendingIssueId: '',
  createIssueId: '',
  createSessionId: '',
  createMutationId: '',
  startMutationId: '',
  attachmentPaths: [],
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
      launchError: typeof value.launchError === 'string' ? value.launchError : '',
    }
  } catch {
    return EMPTY_FIRST_TASK_DRAFT
  }
}

/** Module-level so `usePersistedUiState` gets a stable `serialize` identity. */
export function serializeFirstTaskDraft(draft: FirstTaskDraft): string {
  return JSON.stringify(draft)
}

export function persistFirstTaskDraft(uiState: Pick<UiState, 'set'>, draft: FirstTaskDraft): void {
  uiState.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, serializeFirstTaskDraft(draft))
}

export function clearFirstTaskDraft(uiState: Pick<UiState, 'set'>): void {
  uiState.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, null)
}
