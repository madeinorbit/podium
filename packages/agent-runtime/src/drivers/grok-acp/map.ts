import type { SessionId } from '@podium/model'
import type { InteractionAnswer, PendingInteraction, PermissionAnswer } from '../../interactions.js'
import type { Refusal } from '../../turns.js'
import type { GrokAcpPermissionOption, GrokAcpPermissionRequest, GrokAcpRpcId } from './protocol.js'

const SUMMARY_MAX = 300

const normalizeKind = (kind: string): string => kind.trim().toLowerCase().replaceAll('-', '_')

const safeJson = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text) return undefined
    return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`
  } catch {
    return undefined
  }
}

export interface GrokPermissionAsk {
  requestId: GrokAcpRpcId
  request: GrokAcpPermissionRequest
  interaction: PendingInteraction
}

export function grokPermissionAsk(input: {
  requestId: GrokAcpRpcId
  request: GrokAcpPermissionRequest
  podiumSessionId: SessionId
  at: string
}): GrokPermissionAsk {
  const tool = input.request.toolCall
  const toolName =
    (typeof tool.rawInput === 'object' &&
    tool.rawInput !== null &&
    'variant' in tool.rawInput &&
    typeof tool.rawInput.variant === 'string'
      ? tool.rawInput.variant
      : undefined) ??
    tool.kind ??
    tool.title ??
    'tool'
  const interaction: PendingInteraction = {
    id: String(input.requestId),
    sessionId: input.podiumSessionId,
    kind: 'permission',
    payload: {
      v: 1,
      toolName,
      ...(safeJson(tool.rawInput) ? { inputSummary: safeJson(tool.rawInput) } : {}),
      canAlwaysAllow: input.request.options.some(
        (option) => normalizeKind(option.kind) === 'allow_always',
      ),
      suggestions: input.request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    },
    askedAt: input.at,
    source: 'protocol',
    answerable: 'structured',
  }
  return { requestId: input.requestId, request: input.request, interaction }
}

export type GrokPermissionAction =
  | { ok: true; option: GrokAcpPermissionOption }
  | { ok: false; refusal: Refusal }

/**
 * Select from the options Grok actually supplied for THIS request.
 *
 * No arm assumes a conventional option id. Builds differ in both ids and the
 * set of decisions offered; consulting `options` for allow, always and deny is
 * what prevents an absent deny arm from becoming an accidental approval.
 */
export function grokPermissionAction(
  ask: GrokPermissionAsk,
  answer: PermissionAnswer,
): GrokPermissionAction {
  const wanted =
    answer.decision === 'allow-once'
      ? ['allow_once']
      : answer.decision === 'allow-always'
        ? ['allow_always']
        : ['reject_once', 'reject_always', 'deny_once', 'deny']
  for (const kind of wanted) {
    const option = ask.request.options.find((candidate) => normalizeKind(candidate.kind) === kind)
    if (option) return { ok: true, option }
  }
  return {
    ok: false,
    refusal: {
      reason: 'unsupported',
      detail: `Grok did not offer '${answer.decision}' for this permission request`,
    },
  }
}

export function asPermissionAnswer(answer: unknown): PermissionAnswer | undefined {
  if (
    typeof answer !== 'object' ||
    answer === null ||
    !('kind' in answer) ||
    answer.kind !== 'permission' ||
    !('decision' in answer) ||
    !['allow-once', 'allow-always', 'deny'].includes(String(answer.decision))
  ) {
    return undefined
  }
  return answer as PermissionAnswer
}

export function interactionAnswerKind(answer: InteractionAnswer): string {
  return answer.kind
}
