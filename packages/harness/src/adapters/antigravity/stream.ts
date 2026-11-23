import { isRecord, stringField } from '../shared/json-util.js'

/** agy --output-format stream-json, measured against the native CLI. A result
 * envelope is required: a clean process exit alone never proves completion. */
export function createAntigravityStreamReducer() {
  let sessionId: string | undefined
  let output = ''
  let error: string | undefined
  let completed = false
  let itemHint = ''
  let partialText = ''
  function push(
    raw: unknown,
  ):
    | { sessionId?: string; partialText?: string; itemHint?: string; toolLabel?: string }
    | undefined {
    if (!isRecord(raw)) return undefined
    if (raw.event === 'init') {
      sessionId = stringField(raw, 'conversation_id') ?? sessionId
      return sessionId ? { sessionId } : undefined
    }
    if (raw.event === 'step_update' && isRecord(raw.step_update)) {
      const step = raw.step_update
      sessionId = stringField(step, 'conversation_id') ?? sessionId
      const hint = `${sessionId ?? ''}:${String(step.step_index ?? '')}`
      if (hint !== itemHint) {
        partialText = ''
        itemHint = hint
      }
      if (typeof step.text_delta === 'string' && step.step_type === 'agent_response') {
        partialText += step.text_delta
        return { ...(sessionId ? { sessionId } : {}), partialText, itemHint }
      }
      if (isRecord(step.tool_call))
        return { toolLabel: stringField(step.tool_call, 'name') ?? 'tool' }
      if (step.step_type && !['agent_response', 'user_input'].includes(String(step.step_type)))
        return { toolLabel: String(step.step_type) }
    }
    if (raw.event === 'result' && isRecord(raw.result)) {
      const result = raw.result
      sessionId = stringField(result, 'conversation_id') ?? sessionId
      output = typeof result.response === 'string' ? result.response : ''
      completed = true
      error =
        result.status === 'SUCCESS' && !result.finished_reason
          ? undefined
          : (stringField(result, 'error') ??
            `Antigravity turn ended: ${String(result.finished_reason ?? result.status ?? 'unknown')}`)
      return {
        ...(sessionId ? { sessionId } : {}),
        ...(output ? { partialText: output, itemHint } : {}),
      }
    }
    return undefined
  }
  return {
    push,
    pushLine(line: string) {
      try {
        return push(JSON.parse(line))
      } catch {
        return undefined
      }
    },
    result: () => ({
      sessionId,
      output,
      error: error ?? (completed ? undefined : 'Antigravity stream ended without a result'),
    }),
  }
}
