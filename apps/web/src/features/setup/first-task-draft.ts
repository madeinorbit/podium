import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import type { UiState } from '@podium/client-core/ui-state'
import { asIssueId, asMutationId, type IssueId, type MutationId } from '@podium/model'
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
  /** Set once the tracked task exists; retries start this issue instead of creating another. */
  pendingIssueId: IssueId | ''
  createMutationId: MutationId | ''
  startMutationId: MutationId | ''
}

export const EMPTY_FIRST_TASK_DRAFT: FirstTaskDraft = {
  repoPath: '',
  machineId: '',
  agent: '',
  model: 'auto',
  effort: 'auto',
  title: '',
  description: '',
  pendingIssueId: '',
  createMutationId: '',
  startMutationId: '',
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
      pendingIssueId:
        typeof value.pendingIssueId === 'string' && value.pendingIssueId
          ? asIssueId(value.pendingIssueId)
          : '',
      createMutationId:
        typeof value.createMutationId === 'string' && value.createMutationId
          ? asMutationId(value.createMutationId)
          : '',
      startMutationId:
        typeof value.startMutationId === 'string' && value.startMutationId
          ? asMutationId(value.startMutationId)
          : '',
    }
  } catch {
    return EMPTY_FIRST_TASK_DRAFT
  }
}

export function persistFirstTaskDraft(uiState: Pick<UiState, 'set'>, draft: FirstTaskDraft): void {
  uiState.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, JSON.stringify(draft))
}

export function clearFirstTaskDraft(uiState: Pick<UiState, 'set'>): void {
  uiState.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, null)
}
