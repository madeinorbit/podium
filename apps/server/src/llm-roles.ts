// The one-shot (non-harness) LLM primitive for background features (issue
// assistant, title generation, summaries). Features build on completeForRole
// instead of reaching for llmClient directly, so role → backend → account
// resolution lives in one place (SP-6454, stream B1).
//
// Interactive-session roles (coding sessions, superagent turns) run through the
// daemon harness path, not here.
import type { AccountId, UserId } from '@podium/model'
import { type PodiumSettings, resolveRole, roleApiBackend } from '@podium/runtime'
import type { z } from 'zod'
import { type LlmClient, type LlmMessage, llmClient } from './llm'
import { LlmConfigError } from './llm-error'
import { managedKeyFor, managedKeyName } from './modules/sessions/account-env'
import type { AccountsRepository } from './store/accounts'

/** Roles that make a one-shot completion. */
export type OneShotRole = 'background' | 'superagent'

/** Resolve a role's one-shot (api) backend from the unified role model. A role
 *  whose account is a harness yields kind:'harness', which llmClient rejects
 *  (harness-print one-shot is still "coming soon"). */
export function resolveOneShotBackend(settings: PodiumSettings, role: OneShotRole) {
  return roleApiBackend(settings, role)
}

/** The account a one-shot role call runs on: the role's selected account id
 *  and the provider its backend resolved to. */
export interface OneShotAccount {
  accountId: AccountId
  provider: string
}

export interface CompleteForRoleDeps {
  settings: PodiumSettings
  /**
   * Resolve the API key for the role's account, at the moment of use — POD-419,
   * POD-469.
   *
   * REQUIRED, and that is the point. It used to be read off `settings.apiKeys`,
   * which no longer carries material: the secrets moved to the server-only keyed
   * store. Optional-with-a-default would mean a caller that forgot to inject it
   * silently loses every one-shot completion with a "no API key configured"
   * error that looks like an unconfigured instance — so the composition root is
   * made to name its source. Production composes {@link oneShotApiKey}, the
   * same managed-account rule a coding spawn uses. An account with no usable
   * credential answers `undefined`, which is a real "not configured" and fails
   * closed.
   */
  apiKey: (account: OneShotAccount) => string | undefined | Promise<string | undefined>
  /** Injectable client factory (tests / alternate transports). */
  llm?: typeof llmClient
}

interface BaseOpts {
  role: OneShotRole
  messages: LlmMessage[]
  /** Accepted for forward-compat; the api path wires effort in B3
   *  (RoleBackend.effort). Ignored today. */
  effort?: string
}

/**
 * Resolve a role's backend + account, run a single completion, and optionally
 * parse the response into structured data. With `parse`, `data` is the parsed
 * value (or null when the model's output can't be parsed); without it, `data`
 * is the raw text. Throws on config/network errors — callers decide whether to
 * treat a failure as a no-op (as the issue assistant does).
 */
export async function completeForRole(
  deps: CompleteForRoleDeps,
  opts: BaseOpts,
): Promise<{ text: string; data: string; label: string }>
export async function completeForRole<T>(
  deps: CompleteForRoleDeps,
  opts: BaseOpts & { parse: (text: string) => T | null },
): Promise<{ text: string; data: T | null; label: string }>
export async function completeForRole<T>(
  deps: CompleteForRoleDeps,
  opts: BaseOpts & { parse?: (text: string) => T | null },
): Promise<{ text: string; data: T | null | string; label: string }> {
  const backend = resolveOneShotBackend(deps.settings, opts.role)
  const { accountId } = resolveRole(deps.settings, opts.role)
  const factory = deps.llm ?? llmClient
  const client: LlmClient = factory(
    backend,
    await deps.apiKey({ accountId, provider: backend.provider }),
  )
  const resp = await client.complete(opts.messages, [])
  const data = opts.parse ? opts.parse(resp.text) : resp.text
  return { text: resp.text, data, label: client.label }
}

export interface OneShotCredentialPorts {
  accounts: Pick<AccountsRepository, 'own' | 'sharedWith'>
  /** The instance's pre-hub provider key (`apiKeys.<provider>` in the
   *  server-only keyed store). Read only: nothing on this path writes it. */
  legacyApiKey: (provider: string) => Promise<string | undefined>
}

/**
 * The API key a one-shot role call spends, for ONE member (POD-469).
 *
 * ONE STORE, ONE RULE. Coding spawns resolve a `managed:<provider>` account
 * from the accounts table: the member's own key, then a key another member
 * explicitly shares with them ({@link managedKeyFor}). The one-shot path used
 * to read only the instance's legacy keyed store, so a key connected in the
 * Accounts hub served coding sessions and silently not the background role.
 * Both paths now go through the same function.
 *
 * WHOSE KEY. `actor` is the member the call acts for. An unshared key of
 * another member is never a fallback, admins included. The background digest
 * has no requesting user; its caller passes the member whose settings name the
 * role (the first admin), so the role's configuration and the key it spends
 * belong to the same person.
 *
 * LEGACY, READ ONLY. With no managed key in reach, the plain
 * `managed:<provider>` account falls back to the instance's legacy key, which
 * is instance configuration rather than any member's connection. Any other
 * managed account (`managed:claude-oauth`) never falls back: spending an API
 * key where the role selected a subscription would bill a different account.
 *
 * A native (harness) account needs no key: Codex runs on the login catalog's
 * transport, and any other harness is refused by `llmClient`.
 */
export async function oneShotApiKey(
  ports: OneShotCredentialPorts,
  actor: UserId,
  account: OneShotAccount,
): Promise<string | undefined> {
  if (!account.accountId.startsWith('managed:')) return undefined
  const row = await managedKeyFor(ports.accounts, actor, account.accountId)
  if (row) {
    if (row.kind !== 'api-key') {
      throw new LlmConfigError(
        `the ${managedKeyName(account.accountId)} cannot serve one-shot background calls; ` +
          'select an API key account for this role in Settings → Accounts',
      )
    }
    return row.credential
  }
  if (account.accountId !== `managed:${account.provider}`) return undefined
  return await ports.legacyApiKey(account.provider)
}

/**
 * Adapt a zod schema into a lenient `parse` function: pull the first fenced or
 * braced JSON object out of the model's text and validate it. New structured
 * features (title generation) pass `jsonSchema(MySchema)` as `parse`.
 */
export function jsonSchema<T>(schema: z.ZodType<T>): (text: string) => T | null {
  return (text: string) => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const raw = (fenced?.[1] ?? text).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end < start) return null
    try {
      const result = schema.safeParse(JSON.parse(raw.slice(start, end + 1)))
      return result.success ? result.data : null
    } catch {
      return null
    }
  }
}
