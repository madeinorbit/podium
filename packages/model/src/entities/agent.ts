/**
 * Agent / harness identity vocabulary (relocated from `@podium/protocol`'s
 * `messages/terminal.ts` and `messages/harness.ts` at POD-300).
 *
 * These two enums are the identity half of harness identity; the BEHAVIOUR half
 * (per-kind capability flags, launch commands, adapters) deliberately stays out
 * of L0 — it lives in `@podium/protocol`'s capability table and in
 * `@podium/agent-bridge`'s adapters, which is what the architecture manifest's
 * harness axiom enforces. POD-303 owns the rest of that split.
 */

import { z } from 'zod'

export const AgentKind = z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'shell'])
export type AgentKind = z.infer<typeof AgentKind>

/** Type guard for the wire kind (superagent metadata, hook payloads, …). */
export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AgentKind.options as readonly string[]).includes(v)
}

/** The non-interactive harness surfaces the daemon can drive (AgentKind minus 'shell'). */
export const HarnessAgent = z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor'])
export type HarnessAgent = z.infer<typeof HarnessAgent>
