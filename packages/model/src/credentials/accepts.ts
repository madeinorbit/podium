/**
 * WHAT A CONSUMER ACCEPTS (credential management spec §5).
 *
 * A consumer declares which credential types it takes and how each one is
 * handed over. A harness does it on its adapter (`HarnessInventory.accepts`);
 * direct inference does it in {@link INFERENCE_ROUTES}. Whether a credential
 * can be used somewhere is the match between its type and these declarations,
 * so a pairing nobody declared cannot be selected at all (§3 R2).
 */

import type { HarnessAgent } from '../entities/agent'
import type { CredentialTypeId, CredentialTypeSpec } from './types'

/**
 * How a secret reaches a harness. `env`: set as an environment variable when
 * the process starts, never written to disk. `home`: nothing is moved; the
 * harness starts with its configuration directory pointed at the home that
 * holds the login.
 */
export type Delivery = { kind: 'env'; variable: string } | { kind: 'home' }

export interface AcceptedCredential {
  type: CredentialTypeId
  deliver: Delivery
  /** The drivers this line holds for. Absent: every driver of the harness. */
  drivers?: readonly string[]
  /**
   * Arguments a process start adds, right after the executable, when this
   * line delivers (an `env` line: the start that carries its variable). They
   * say how the harness reads the delivered secret, such as the model
   * provider Codex runs a ChatGPT plan through. They never hold the secret.
   */
  startArgs?: readonly string[]
  /**
   * Arguments added after `startArgs` only when the process runs in the
   * Podium home (managed installs §4.3): a home that holds no login of its
   * own, where a harness that otherwise reads its login file must be told to
   * read the delivered variable. Never the secret.
   */
  homeStartArgs?: readonly string[]
}

/** How a direct model call is served for a credential of one type. */
export type InferenceRoute =
  | {
      kind: 'http'
      api: 'anthropic-messages' | 'openai-chat' | 'openai-responses'
      base?: 'openrouter'
    }
  | { kind: 'on-machine'; api: 'openai-responses' }
  | { kind: 'harness-one-shot'; harness: HarnessAgent }

/**
 * The routes direct inference declares. `anthropic.claude-login` through
 * Claude Code's one-shot mode is added only if measurement S5 passes (§19).
 */
export const INFERENCE_ROUTES: Readonly<Partial<Record<CredentialTypeId, InferenceRoute>>> = {
  'anthropic.api-key': { kind: 'http', api: 'anthropic-messages' },
  'openai.api-key': { kind: 'http', api: 'openai-chat' },
  'openrouter.api-key': { kind: 'http', api: 'openai-chat', base: 'openrouter' },
  'openai.chatgpt-login': { kind: 'on-machine', api: 'openai-responses' },
  'openai.chatgpt-plan': { kind: 'http', api: 'openai-responses' },
}

/** One consumer's declarations as the matching check reads them. `type` is a
 *  plain string so a declaration of an id outside the registry can be found. */
export interface AcceptsConsumer {
  kind: string
  accepts: readonly { type: string; drivers?: readonly string[] }[]
}

export type AcceptsProblem =
  /** No consumer accepts the type and no inference route serves it: it could never be used. */
  | { kind: 'unused-type'; type: string }
  /** A consumer accepts an id the registry does not know. */
  | { kind: 'unknown-type'; consumer: string; type: string }
  /** A consumer accepts one type twice for drivers that overlap, so delivery is ambiguous. */
  | { kind: 'duplicate-type'; consumer: string; type: string }

function driversOverlap(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === undefined || b === undefined) return true
  return a.some((driver) => b.includes(driver))
}

/**
 * Everything wrong with a set of declarations against a registry, in a stable
 * order: unknown and duplicate ids per consumer first (consumer order, then
 * line order), then unused types (registry order). Empty means consistent.
 */
export function acceptsProblems(input: {
  types: Readonly<Record<string, CredentialTypeSpec>>
  routes: Readonly<Partial<Record<string, InferenceRoute>>>
  consumers: readonly AcceptsConsumer[]
}): AcceptsProblem[] {
  const problems: AcceptsProblem[] = []
  const used = new Set<string>(Object.keys(input.routes))
  for (const consumer of input.consumers) {
    consumer.accepts.forEach((line, index) => {
      used.add(line.type)
      if (!(line.type in input.types)) {
        problems.push({ kind: 'unknown-type', consumer: consumer.kind, type: line.type })
      }
      const clash = consumer.accepts
        .slice(0, index)
        .some(
          (earlier) => earlier.type === line.type && driversOverlap(earlier.drivers, line.drivers),
        )
      if (clash) problems.push({ kind: 'duplicate-type', consumer: consumer.kind, type: line.type })
    })
  }
  for (const type of Object.keys(input.types)) {
    if (!used.has(type)) problems.push({ kind: 'unused-type', type })
  }
  return problems
}
