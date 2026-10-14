/**
 * THE ASK-THE-USER GATE (POD-6108, ANALYSIS.md D5).
 *
 * Only a session with no coordinator above it may talk to the user. Every other
 * session is denied the harness's built-in ask-the-user tools, and the denial
 * carries the server's seat text naming the coordinator's issue to mail instead.
 *
 * Each engine meets the ask at its own seam — a PreToolUse hook (Claude and Grok
 * terminals), a `can_use_tool` permission (the Claude stream engine), a question
 * event (OpenCode serve), an ACP server request (Grok) — and asks the same gate.
 * The gate is the server's word; this module owns only the tool names, the hook
 * wire, and the bound. Every path fails OPEN: a gate that cannot answer in time
 * lets the ask through rather than stranding a turn on a missing reply.
 *
 * Which tools exist and which denials reach the model were RUN against each real
 * CLI with a fake model server (2026-10-14): Claude 2.1.299, Grok 1.0.52,
 * OpenCode 1.18.35, Codex 0.162.1 (whose `request_user_input` already refuses
 * itself outside Plan mode, which Podium never sets), Pi 1.1.0 (no such tool).
 */

import type { SessionId } from '@podium/model'
import { hookEventName, hookString, isGrokHookPayload } from '../../adapters/shared/hook-fields.js'

/** `null` = this session may ask the user; a string = the refusal the model reads. */
export type AskUserGate = (sessionId: SessionId, signal?: AbortSignal) => Promise<string | null>

/**
 * The built-in tools that stop a turn to wait on a person: an interview, or a
 * plan-mode switch the person approves. Entering plan mode is gated with leaving
 * it, so a session that may not ask can never be stuck in a mode only a person
 * can end.
 */
const ASK_USER_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  // Grok
  'ask_user_question',
  'enter_plan_mode',
  'exit_plan_mode',
  // Codex (Plan mode only)
  'request_user_input',
])

export function isAskUserTool(name: string | undefined): boolean {
  return name !== undefined && ASK_USER_TOOLS.has(name)
}

/** The bound one gate read may take. Under the hook ingest's 3 s reply budget. */
export const ASK_USER_GATE_DEADLINE_MS = 2_500

/** Ask the gate, bounded; a failure or a timeout is an allow. */
export async function askUserRefusal(
  gate: AskUserGate | undefined,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!gate || signal?.aborted) return null
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, ASK_USER_GATE_DEADLINE_MS)
  })
  try {
    const reason = await Promise.race([gate(sessionId, controller.signal), expired])
    return typeof reason === 'string' && reason.trim() ? reason : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Answer one hook payload: a PreToolUse for an ask-the-user tool from a session
 * the gate refuses gets the harness's deny body; anything else gets `null`.
 * Claude reads `hookSpecificOutput.permissionDecision`, Grok reads `decision`;
 * both show the reason to the model as the tool's error.
 */
export async function askUserHookResponse(
  gate: AskUserGate | undefined,
  sessionId: SessionId,
  payload: unknown,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!gate || hookEventName(payload) !== 'PreToolUse') return null
  if (!isAskUserTool(hookString(payload, 'tool_name', 'toolName'))) return null
  const reason = await askUserRefusal(gate, sessionId, signal)
  if (reason === null) return null
  return JSON.stringify(
    isGrokHookPayload(payload)
      ? { decision: 'deny', reason }
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        },
  )
}
