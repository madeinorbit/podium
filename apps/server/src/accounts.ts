// Account discovery for the Accounts & Keys settings hub (SP-6454, stream B2).
//
// Makes auth first-class and VISIBLE: native CLI logins on this machine (Claude
// Code, Codex/ChatGPT, Grok) shown read-only with their identity, alongside the
// MANAGED credentials Podium holds and injects into an agent's spawn env (#216) —
// a provider API key or a `claude setup-token`. Multi-account oauth ROTATION is
// still modelled only.
//
// Login/profile detection lives on each @podium/agent-bridge harness adapter so
// the daemon inventory and this server-side AccountView use the same facts.
import { homedir } from 'node:os'
import { HARNESS_ADAPTERS } from '@podium/agent-bridge'
import type { HarnessAgent } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import { z } from 'zod'
import type { AccountsRepository } from './store/accounts'

/** Input for `accounts.connect`. OAuth is Anthropic-only: `claude setup-token`
 *  yields the sole long-lived, env-consumable OAuth credential — for any other
 *  provider an oauth row would persist fine but inject NOTHING at spawn time
 *  (credentialEnv maps oauth → CLAUDE_CODE_OAUTH_TOKEN only for anthropic), a
 *  silently dead credential. Reject it loudly at the boundary instead. */
export const AccountConnectInput = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'openrouter']),
    kind: z.enum(['api-key', 'oauth']),
    credential: z.string().min(1),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'oauth' && input.provider !== 'anthropic') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message:
          "OAuth accounts are only supported for Anthropic (claude setup-token); use kind 'api-key' for other providers.",
      })
    }
  })

/** A row in the Accounts hub. Native rows are observed at read-time (identity +
 *  status can drift); managed rows reflect what Podium stores. */
export interface AccountView {
  /** Stable id, e.g. "native:claude-code" or "managed:anthropic". */
  id: string
  provider: string
  source: 'native' | 'managed'
  /** Managed only: how the credential would be injected. */
  kind?: 'api-key' | 'oauth'
  /** Native only: which harness login this is. */
  harness?: string
  /** Observed, human-facing: an email/plan, a masked key, or a hint. */
  identity?: string
  status: 'connected' | 'not-configured'
  /** Managed only: where the credential actually lives.
   *  'stored' — a row in the accounts table: Podium injects it at spawn, and
   *    `accounts.disconnect` can really delete it.
   *  'legacy' — no row; the value comes from the pre-hub `settings.apiKeys`.
   *    accounts.remove() would delete NOTHING, so the UI must not offer a
   *    Disconnect the server cannot honour (it points at Settings → API keys). */
  credentialSource?: 'stored' | 'legacy'
}

/** Display-only preview of a secret. The full value never leaves the server. */
export function maskCredential(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

function detectNative(homeDir: string, kind: HarnessAgent, provider: string): AccountView {
  const login = HARNESS_ADAPTERS[kind].inventory.detectLogin(homeDir)
  return {
    id: `native:${kind}`,
    provider,
    source: 'native',
    harness: kind,
    identity: login.account,
    status: login.state === 'in' ? 'connected' : 'not-configured',
  }
}

const MANAGED_KEY_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const

/**
 * All accounts for the hub: native CLI logins on this machine (observed) plus
 * the managed credentials Podium holds (#216) — provider API keys and the Claude
 * subscription setup-token.
 *
 * Managed rows are read from the accounts TABLE, never from the settings blob:
 * settings round-trips to every client wholesale, so a credential kept there
 * would ship to the browser. Only the masked `identity` is ever returned.
 */
export function accountViews(
  settings: PodiumSettings,
  accounts: AccountsRepository,
  homeDir: string = homedir(),
): AccountView[] {
  const native = [
    detectNative(homeDir, 'claude-code', 'anthropic'),
    detectNative(homeDir, 'codex', 'openai'),
    detectNative(homeDir, 'grok', 'xai'),
  ]

  // Managed rows: a stored credential (#216) wins; otherwise fall back to the
  // legacy settings.apiKeys value so an existing key keeps showing as connected.
  //
  // Status keys off the ROW'S EXISTENCE, never the truthiness of its identity: an
  // identity is only a display mask, and a row with an empty one still holds a
  // live credential that spawns inject. Keying on identity would render a working
  // account as "not configured".
  const stored = new Map(accounts.list().map((a) => [a.id, a]))
  const managed: AccountView[] = MANAGED_KEY_PROVIDERS.map((provider) => {
    const id = `managed:${provider}`
    const row = stored.get(id)
    const legacyKey = settings.apiKeys[provider] ?? ''
    if (row) {
      return {
        id,
        provider,
        source: 'managed' as const,
        kind: 'api-key' as const,
        identity: row.identity || undefined,
        status: 'connected' as const,
        credentialSource: 'stored' as const,
      }
    }
    if (legacyKey) {
      return {
        id,
        provider,
        source: 'managed' as const,
        kind: 'api-key' as const,
        identity: maskCredential(legacyKey),
        status: 'connected' as const,
        credentialSource: 'legacy' as const,
      }
    }
    return {
      id,
      provider,
      source: 'managed' as const,
      kind: 'api-key' as const,
      status: 'not-configured' as const,
    }
  })

  // The Claude subscription OAuth token (`claude setup-token`) — a managed account
  // with no legacy settings equivalent, so it only ever comes from the store.
  const oauthRow = stored.get('managed:claude-oauth')
  const claudeOauth: AccountView = {
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    source: 'managed',
    kind: 'oauth',
    identity: oauthRow?.identity || undefined,
    ...(oauthRow
      ? { status: 'connected' as const, credentialSource: 'stored' as const }
      : { status: 'not-configured' as const }),
  }

  return [...native, ...managed, claudeOauth]
}
