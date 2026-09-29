/**
 * The subset of Agent Client Protocol spoken by `grok agent stdio`.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio.  Core method names are
 * stable; Grok's `_x.ai/*` additions are deliberately treated as optional
 * side-channel frames except for `_x.ai/session/update` and
 * `_x.ai/session_notification`, whose payloads use the same update vocabulary
 * Podium already consumes from `updates.jsonl`.
 */
import { z } from 'zod'

export const GrokAcpRpcId = z.union([z.number(), z.string()])
export type GrokAcpRpcId = z.infer<typeof GrokAcpRpcId>

export const GrokAcpFrame = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: GrokAcpRpcId.optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough()
export type GrokAcpFrame = z.infer<typeof GrokAcpFrame>

export const GrokAcpStopReason = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
])
export type GrokAcpStopReason = z.infer<typeof GrokAcpStopReason>

export const GrokAcpPromptResult = z
  .object({
    stopReason: GrokAcpStopReason,
    _meta: z
      .object({
        usage: z
          .object({
            inputTokens: z.number().optional(),
            outputTokens: z.number().optional(),
            totalTokens: z.number().optional(),
            cachedReadTokens: z.number().optional(),
            cacheCreationTokens: z.number().optional(),
            reasoningTokens: z.number().optional(),
            costUsdTicks: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type GrokAcpPromptResult = z.infer<typeof GrokAcpPromptResult>

export const GrokAcpSessionResult = z
  .object({
    sessionId: z.string().min(1),
  })
  .passthrough()
export type GrokAcpSessionResult = z.infer<typeof GrokAcpSessionResult>

export const GrokAcpInitializeResult = z
  .object({
    protocolVersion: z.number().optional(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
export type GrokAcpInitializeResult = z.infer<typeof GrokAcpInitializeResult>

export const GrokAcpPermissionOption = z
  .object({
    optionId: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().min(1),
  })
  .passthrough()
export type GrokAcpPermissionOption = z.infer<typeof GrokAcpPermissionOption>

export const GrokAcpPermissionRequest = z
  .object({
    sessionId: z.string().min(1),
    toolCall: z
      .object({
        toolCallId: z.string().min(1),
        kind: z.string().optional(),
        title: z.string().optional(),
        rawInput: z.unknown().optional(),
      })
      .passthrough(),
    options: z.array(GrokAcpPermissionOption).readonly(),
  })
  .passthrough()
export type GrokAcpPermissionRequest = z.infer<typeof GrokAcpPermissionRequest>

export const GrokAcpSessionUpdate = z.object({
  method: z.enum(['session/update', '_x.ai/session/update', '_x.ai/session_notification']),
  params: z
    .object({
      sessionId: z.string().min(1),
      update: z.record(z.string(), z.unknown()),
      _meta: z
        .object({
          eventId: z.string().min(1).optional(),
          agentTimestampMs: z.number().optional(),
          /** The turn this update belongs to (grok 1.0.x): ours when the
           *  prompt carried one, else the id Grok minted. */
          promptId: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
})
export type GrokAcpSessionUpdate = z.infer<typeof GrokAcpSessionUpdate>

/**
 * GROK'S PROMPT QUEUE, AND ITS ACK OF A PROMPT (POD-4837).
 *
 * `_x.ai/queue/changed` is the frame Grok's own headless client acknowledges a
 * prompt by. Measured on grok 1.0.44: 4–90 ms after `session/prompt`, one frame
 * lists the prompt among `entries` under its promptId, and the next names it
 * `runningPromptId`. It carries no event id: an acknowledgement, not history.
 */
export const GrokAcpQueueChanged = z
  .object({
    sessionId: z.string().min(1),
    entries: z
      .array(z.object({ id: z.string().min(1), text: z.string().optional() }).passthrough())
      .default([]),
    runningPromptId: z.string().min(1).optional(),
    runningText: z.string().optional(),
  })
  .passthrough()
export type GrokAcpQueueChanged = z.infer<typeof GrokAcpQueueChanged>

export const GROK_ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  requestPermission: 'session/request_permission',
  queueChanged: '_x.ai/queue/changed',
} as const

export class GrokAcpRpcError extends Error {
  constructor(
    readonly code: number,
    readonly method: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(`grok ACP ${method} failed (${code}): ${message}`)
    this.name = 'GrokAcpRpcError'
  }
}

export class GrokAcpProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokAcpProtocolError'
  }
}

/** Parse only the cursor-bearing update stream. Other `_x.ai/*` frames remain
 * intentionally ignored; Grok's live failure notifications are accepted here
 * because this build gives them the same cursor envelope as ordinary updates. */
export function parseGrokAcpSessionUpdate(frame: GrokAcpFrame): GrokAcpSessionUpdate | null {
  if (
    frame.method !== 'session/update' &&
    frame.method !== '_x.ai/session/update' &&
    frame.method !== '_x.ai/session_notification'
  )
    return null
  const parsed = GrokAcpSessionUpdate.safeParse({ method: frame.method, params: frame.params })
  return parsed.success ? parsed.data : null
}

/** The turn an update belongs to: `_meta.promptId` on a chunk, or the
 *  `prompt_id` a turn or hook notification carries in its body. */
export function grokAcpPromptId(update: GrokAcpSessionUpdate): string | undefined {
  const stamped = update.params._meta?.promptId
  if (stamped) return stamped
  const body = update.params.update.prompt_id
  return typeof body === 'string' && body ? body : undefined
}

export function grokAcpEventOrdinal(eventId: string | undefined): number | undefined {
  if (!eventId) return undefined
  const match = /-(\d+)$/.exec(eventId)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
