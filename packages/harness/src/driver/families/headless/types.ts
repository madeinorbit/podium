// packages/harness/src/driver/families/headless/types.ts
//
// THE ONE-SHOT HEADLESS TURN, AS EVERY CALLER NAMES IT (POD-4614).
//
// Moved from apps/daemon/src/headless-drivers.ts when one-shot turns moved
// under podium-host: the daemon stops owning the turn's shape, and keeps only
// the facts it composes (the child environment, the durable label, the
// session layer's process owner).

import type { AccountId, HarnessAgent, SessionId } from '@podium/model'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { HeadlessTurnFailure } from '../turn-error.js'

export const DEFAULT_HEADLESS_TURN_TIMEOUT_MS = 600_000

export interface HeadlessTurnSpec {
  agent: HarnessAgent
  accountId: AccountId
  requestDigest: string
  model?: string
  effort?: string
  cwd: string
  prompt: string
  contextPrompt?: string
  systemPrompt?: string
  /** MCP config JSON ({ mcpServers: { name: { url, headers } } }). */
  mcpConfig?: string
  allowedTools?: string[]
  permissionMode?: string
  toolPolicy?: 'none'
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** Server pre-minted first-turn session id (pre-mintable harnesses). */
  sessionUuid?: string
  timeoutMs?: number
  /** Instance-owned child environment (HOME + CLI/session routing). */
  env?: Record<string, string>
  /** Exact durable host label for the owning session: the turn's host runs
   *  under it, and a restarted daemon finds the turn by it. */
  durableLabel?: string
  /** Absolute executable captured from the current generation. */
  executablePath?: string
  /** Route tool authorization through structured RuntimeDriver interactions. */
  structuredPermissions?: true
}

export interface HeadlessTurnOutcome {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  harnessSessionId: string
  output: string
  observedModel?: string
  observedEffort?: string
}

/**
 * A turn that failed AFTER the harness minted its session. The conversation
 * exists on disk, so the caller must still learn its id — otherwise one
 * interrupted/errored turn orphans the whole thread: no resume ref, no
 * transcript binding, and the next turn silently starts a new conversation.
 */
export class HeadlessTurnError extends HeadlessTurnFailure {
  constructor(
    message: string,
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    harnessSessionId?: string,
  ) {
    super(message, harnessSessionId)
    this.name = 'HeadlessTurnError'
  }
}

export type HeadlessEmit = (event: HeadlessTurnEvent) => void

/** The durable identity of one hosted turn: all four must match for a
 *  restarted daemon to adopt (or replay) the host it finds under the label. */
export interface HostedTurnIdentity {
  sessionId: SessionId
  turnId: string
  requestDigest: string
  accountId: AccountId
}

export interface HeadlessTurnHandle {
  /** Stable durable turn id when the control layer assigned one. */
  turnId?: string
  done: Promise<HeadlessTurnOutcome>
  interrupt(): void
  /** Detach local resources without killing the host. */
  dispose?(): void
  /** Structured claude turns only: answer the exact permission ask. */
  answerPermission?(
    interactionId: string,
    answer: {
      decision: 'allow-once' | 'allow-always' | 'deny'
      feedback?: string
    },
  ): void
}

/** Live callbacks a structured-permission turn routes into interactions. Only
 *  the stream-json claude turn honours them; every other turn is a
 *  non-interactive CLI surface with no permission channel. */
export interface HeadlessTurnHooks {
  onPermission?: (request: {
    id: string
    toolName: string
    input?: unknown
    suggestions?: readonly unknown[]
  }) => void
  onToolCall?: (call: { toolUseId: string; toolName: string; input?: unknown }) => void
  onToolResult?: (result: { toolUseId: string; output: string; isError?: boolean }) => void
}
