import type { AgentStateEvent } from './types.js'

export const GLOBAL_AGENT_STATE_LABELS = [
  'new',
  'working',
  'working.waiting_on_subagent',
  'working.waiting_on_shell',
  'error',
  'idle.finished',
  'idle.interrupted',
  'idle.needs_input.ask_user_tool',
  'idle.needs_input.permission',
  'idle.needs_input.approval',
  'idle.needs_input.open_todo_list',
  'idle.needs_input.text_question',
] as const

export type GlobalAgentStateLabel = (typeof GLOBAL_AGENT_STATE_LABELS)[number]

export type DeterministicAgentState =
  | {
      status: 'resolved'
      label: GlobalAgentStateLabel
      reason: string
      confidence: number
      summary?: string
      errorClass?: string
      retryable?: boolean
    }
  | {
      status: 'needs_semantic_classification'
      candidateLabels: GlobalAgentStateLabel[]
      reason: string
      confidence: number
    }

export function resolvedState(
  label: GlobalAgentStateLabel,
  reason: string,
  opts: { confidence?: number; summary?: string; errorClass?: string; retryable?: boolean } = {},
): DeterministicAgentState {
  return {
    status: 'resolved',
    label,
    reason,
    confidence: opts.confidence ?? 1,
    ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
    ...(opts.errorClass !== undefined ? { errorClass: opts.errorClass } : {}),
    ...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
  }
}

export function semanticState(
  candidateLabels: GlobalAgentStateLabel[],
  reason: string,
): DeterministicAgentState {
  const labels = [...new Set(candidateLabels)]
  return {
    status: 'needs_semantic_classification',
    candidateLabels:
      labels.length > 0 ? labels : ['idle.finished', 'idle.needs_input.text_question'],
    reason,
    confidence: 0.5,
  }
}

/**
 * Current wire-level fallback for deterministic states. The semantic state is
 * intentionally conservative: until a semantic classifier is installed, an
 * ambiguous stopped turn becomes idle/done instead of a noisy false
 * needs-input notification.
 */
export function deterministicStateToEvents(state: DeterministicAgentState): AgentStateEvent[] {
  if (state.status === 'needs_semantic_classification') return [{ kind: 'turn_completed' }]

  switch (state.label) {
    case 'new':
      return [{ kind: 'session_started' }]
    case 'working':
    case 'working.waiting_on_subagent':
    case 'working.waiting_on_shell':
      return [{ kind: 'activity' }]
    case 'error':
      return [
        {
          kind: 'turn_failed',
          errorClass: state.errorClass ?? 'unknown',
          retryable: state.retryable ?? true,
        },
      ]
    case 'idle.finished':
      return [
        {
          kind: 'turn_completed',
          verdict: { kind: 'done', ...(state.summary ? { summary: state.summary } : {}) },
        },
      ]
    case 'idle.interrupted':
      return [
        {
          kind: 'turn_completed',
          verdict: {
            kind: 'interrupted',
            ...(state.summary ? { summary: state.summary } : {}),
          },
        },
      ]
    case 'idle.needs_input.ask_user_tool':
      return [
        {
          kind: 'needs_user',
          need: 'question',
          ...(state.summary ? { summary: state.summary } : {}),
        },
      ]
    case 'idle.needs_input.permission':
      return [
        {
          kind: 'needs_user',
          need: 'permission',
          ...(state.summary ? { summary: state.summary } : {}),
        },
      ]
    case 'idle.needs_input.approval':
      return [
        {
          kind: 'turn_completed',
          verdict: { kind: 'approval', ...(state.summary ? { summary: state.summary } : {}) },
        },
      ]
    case 'idle.needs_input.open_todo_list':
      return [{ kind: 'turn_completed' }]
    case 'idle.needs_input.text_question':
      return [
        {
          kind: 'turn_completed',
          verdict: { kind: 'question', ...(state.summary ? { summary: state.summary } : {}) },
        },
      ]
  }
}
