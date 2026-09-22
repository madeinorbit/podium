/**
 * THE GROK HOOK/SCREEN STATE RULES (POD-4472): the idle-verdict and plan rules
 * for this harness (spec §4: "screen and hook-derived agent state, causal
 * fingerprints").
 *
 * The install layout and payload translation live in `./instrumentation.js`;
 * the state provider beside it (`./state-provider.js`) delegates to them. Grok posts
 * no screen-classifiable prompt and no causal fingerprint — its verdict rules
 * (reading the provider's own idle transcript and todo plan) are the state
 * knowledge this section carries.
 */
import type { AgentStateEvent } from '../../agent-state/types.js'

type GrokIdleVerdict = NonNullable<Extract<AgentStateEvent, { kind: 'turn_completed' }>['verdict']>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function normalizeName(value: string | undefined): string | undefined {
  return value
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

export interface GrokPlanState {
  /** Undefined means no trustworthy full snapshot is available. */
  openTodoCount?: number
  /** Undefined is Grok's ordinary/default mode; null means a malformed mode update. */
  currentMode?: string | null
  /** A structured question/permission always outranks the quiet todo verdict. */
  requiredUserAction: boolean
  /** Used only when reconstructing a resumed session's last idle boundary. */
  cleanEndTurn: boolean
}
const GROK_IDLE_CLASSIFICATION_RECORDS = 256
function grokContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (isRecord(block) && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
const QUESTIONISH =
  /(\?\s*$)|\b(should i|shall i|want me to|would you like|let me know|which (one|option|approach)|do you want)\b/i
export function classifyGrokIdleTranscript(
  records: unknown[],
): { kind: 'done' | 'question' | 'approval'; summary?: string } | undefined {
  const floor = Math.max(0, records.length - GROK_IDLE_CLASSIFICATION_RECORDS)
  for (let i = records.length - 1; i >= floor; i--) {
    const record = records[i]
    if (!isRecord(record) || record.type !== 'assistant') continue
    const text =
      grokContentText(record.content) || grokContentText(recordField(record, 'message')?.content)
    if (!text) continue
    if (QUESTIONISH.test(text.slice(-400))) {
      const summary =
        text
          .split('\n')
          .filter((line) => line.trim())
          .at(-1) ?? text
      return { kind: 'question', summary: summary.trim().slice(0, 140) }
    }
    return { kind: 'done' }
  }
  return undefined
}
export function isGrokPlanMode(mode: string | undefined): boolean {
  const normalized = normalizeName(mode)
  return normalized === 'plan' || normalized === 'plan_mode'
}
export function withGrokOpenTodos(
  classified: GrokIdleVerdict | undefined,
  state: GrokPlanState | undefined,
  eligibleBoundary: boolean,
): GrokIdleVerdict | undefined {
  if (
    !eligibleBoundary ||
    !state ||
    state.openTodoCount === undefined ||
    state.openTodoCount < 1 ||
    state.currentMode === null ||
    isGrokPlanMode(state.currentMode) ||
    state.requiredUserAction ||
    (classified !== undefined && classified.kind !== 'done')
  ) {
    return classified
  }
  return { kind: 'open_todos' }
}
