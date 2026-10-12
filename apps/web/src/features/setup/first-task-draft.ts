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

/** One reported model, as the live catalog carries it. */
export interface ReportedModel {
  value: string
  efforts?: readonly string[]
}

/**
 * THE BOX ONLY LAUNCHES WHAT THE MACHINE SAYS IT CAN RUN (POD-3911).
 *
 * The model and effort pills are the operator's own choice, so the server
 * refuses an unknown one rather than guessing. A pill can still go stale under
 * them: a draft saved weeks ago, or a project switch that moved the launch to a
 * machine with a different model list. Without this the launch was refused for
 * a value the operator never chose on this machine.
 *
 * So once the selected machine has REPORTED its models for this harness, the
 * draft is brought into line with that list, visibly, in the pills:
 *  - a model the list does not contain goes back to Auto, and its effort with it;
 *  - an effort goes back to Auto unless the model is concrete AND the list names
 *    that effort for it — the only case the effort pill offers a choice.
 *
 * Nothing changes while the list is still loading or was never reported: then
 * the server cannot check the value either, and it passes. Returns `undefined`
 * when the draft already agrees, so the caller can skip the write.
 */
export function draftForReportedModels(
  draft: FirstTaskDraft,
  reported: readonly ReportedModel[] | undefined,
): FirstTaskDraft | undefined {
  const known = reported !== undefined && reported.length > 0
  const model = draft.model || 'auto'
  const effort = draft.effort || 'auto'
  if (model === 'auto') {
    return effort === 'auto' ? undefined : { ...draft, effort: 'auto' }
  }
  if (!known) return undefined
  const entry = reported.find((candidate) => candidate.value === model)
  if (!entry) return { ...draft, model: 'auto', effort: 'auto' }
  if (effort !== 'auto' && !entry.efforts?.includes(effort)) return { ...draft, effort: 'auto' }
  return undefined
}
