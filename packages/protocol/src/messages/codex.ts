import { z } from 'zod'

// ── Server-side LLM over a catalog Codex login (POD-4750) ───────────────────
// The server's built-in AI (one-shot background completions and any other
// server-side LLM call on the `codex` provider) runs on the ChatGPT login of
// the machine the catalog names — never on a login file on the server's own
// host. The daemon on that machine performs the Codex Responses API call with
// its CLI-maintained token and returns ONLY the model's reply: the token never
// leaves its machine.
//
// The message/tool shapes below mirror the server's internal LLM shapes
// (`apps/server/src/llm.ts`) and the harness's Responses wire
// (`packages/harness/src/adapters/codex/responses.ts`) field for field, so the
// HTTP call the daemon makes is byte-identical to the one the server used to
// make. New fields are additive and optional; an older daemon that does not
// know this frame answers through the frame-guard's payload-rejection arm (and
// daemons predating that arm simply never answer — the server's deadline then
// reports "no reply … may be older", never "offline").

/** One chat message, exactly as the server's LLM layer shapes it. */
export const CodexLlmMessageWire = z.union([
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          /** JSON-encoded arguments, exactly as the model produced them. */
          arguments: z.string(),
        }),
      )
      .optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: z.string(),
    name: z.string(),
  }),
])
export type CodexLlmMessageWire = z.infer<typeof CodexLlmMessageWire>

/** One function tool the model may call. */
export const CodexLlmToolWire = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema for the arguments object. */
  parameters: z.record(z.string(), z.unknown()),
})
export type CodexLlmToolWire = z.infer<typeof CodexLlmToolWire>

// server -> daemon: "run one Responses turn on your machine's Codex login".
export const CodexCompleteRequestMessage = z.object({
  type: z.literal('codexCompleteRequest'),
  requestId: z.string(),
  /** Resolved model ('auto' resolved server-side; the daemon sees a real slug). */
  model: z.string(),
  messages: z.array(CodexLlmMessageWire),
  tools: z.array(CodexLlmToolWire),
  effort: z.enum(['low', 'medium', 'high']),
})
export type CodexCompleteRequestMessage = z.infer<typeof CodexCompleteRequestMessage>

// daemon -> server: the turn's outcome. Failures ride `ok: false` with an
// actionable `error` (login missing/expired, model timeout, backend refusal)
// so the server can surface them instead of timing out. The reply NEVER
// carries credential material — only the model's text and tool calls.
export const CodexCompleteResultMessage = z.object({
  type: z.literal('codexCompleteResult'),
  requestId: z.string(),
  ok: z.boolean(),
  text: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.string(),
      }),
    )
    .optional(),
  error: z.string().optional(),
})
export type CodexCompleteResultMessage = z.infer<typeof CodexCompleteResultMessage>
