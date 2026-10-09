/**
 * THE HOOK-SHAPED WIRE FOR A DRIVER'S BOUNDARY CONTEXT (POD-5814).
 *
 * Claude Code and Codex announce their boundaries with the same hook payloads —
 * `SessionStart`, `UserPromptSubmit`, `PreCompact` — whether the hook reaches
 * Podium over HTTP (a terminal session's `--settings` file) or in band as a
 * stream-json `hook_callback` (the Claude stream engine). This codec maps one
 * such payload onto the driver's {@link BoundaryContextOperation} and the
 * context it returns onto the provider's hidden-context answer. The operation
 * owns once/rearm and fetch state; this owns only the wire.
 */

import { hookEventName, hookString } from '../../adapters/shared/hook-fields.js'
import type { BoundaryContextEvent, BoundaryContextOperation } from '../boundary-context.js'

/** The hidden-context answer a hook-shaped provider reads back. */
export interface BoundaryHookAnswer {
  hookSpecificOutput: { hookEventName: string; additionalContext: string }
}

/** The hook events that carry a boundary, in the providers' own names. */
export const BOUNDARY_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreCompact'] as const

/**
 * Answer one hook payload, or `null` when it is not a boundary or there is
 * nothing to add.
 *
 * Codex never sends PreCompact (its PreCompact supports only the common output
 * fields, never additionalContext); its only post-compaction signal is
 * SessionStart with source `compact`, and a stream-json Claude session reports
 * the same pair. So that start re-arms before priming — otherwise the once/rearm
 * logic would treat it as an already-consumed start and the agent would lose its
 * scoped context after every compaction.
 */
export async function boundaryHookAnswer(
  respond: BoundaryContextOperation,
  payload: unknown,
  signal?: AbortSignal,
): Promise<BoundaryHookAnswer | null> {
  const name = hookEventName(payload)
  if (name === 'SessionStart' && hookString(payload, 'source', 'source') === 'compact') {
    await respond({ event: 'before-compaction' })
  }
  const event: BoundaryContextEvent | undefined =
    name === 'SessionStart'
      ? 'start'
      : name === 'UserPromptSubmit'
        ? 'prompt'
        : name === 'PreCompact'
          ? 'before-compaction'
          : undefined
  if (!name || !event) return null
  const context = await respond({ event, ...(signal ? { signal } : {}) })
  return context === null
    ? null
    : { hookSpecificOutput: { hookEventName: name, additionalContext: context } }
}

/** The same answer as a hook's HTTP response body, or `null` for none. */
export async function boundaryHookResponse(
  respond: BoundaryContextOperation,
  payload: unknown,
  signal?: AbortSignal,
): Promise<string | null> {
  const answer = await boundaryHookAnswer(respond, payload, signal)
  return answer ? JSON.stringify(answer) : null
}
