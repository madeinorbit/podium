// Account discovery for the Accounts & Keys settings hub (SP-6454, stream B2).
//
// Makes auth first-class and VISIBLE: native CLI logins on this machine (Claude
// Code, Codex/ChatGPT, Grok) shown read-only with their identity, alongside the
// managed API keys already stored in settings. MANAGED credential injection into
// harnesses + oauth rotation are modelled but ship "Coming soon" — this slice
// only detects + displays; it never writes a credential.
//
// The raw login detectors live in @podium/agent-bridge (inventory/detect-login,
// #222) so the daemon can report about ITS OWN machine; this module keeps the
// server-side AccountView presentation on top of them.
import { homedir } from 'node:os'
import { detectClaudeLogin, detectCodexLogin, detectGrokLogin } from '@podium/agent-bridge'
import type { PodiumSettings } from '@podium/runtime'
import type { AccountsRepository } from './store/accounts'

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
  /** True for capabilities that are modelled but not yet wired (managed
   *  injection into harnesses, oauth rotation) — the UI disables + labels these. */
  comingSoon?: boolean
}

/** Display-only preview of a secret. The full value never leaves the server. */
export function maskCredential(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/** Native Claude Code login: email lives in ~/.claude.json (oauthAccount),
 *  separate from the credential token. Best-effort. */
function detectClaude(homeDir: string): AccountView {
  const login = detectClaudeLogin(homeDir)
  return {
    id: 'native:claude-code',
    provider: 'anthropic',
    source: 'native',
    harness: 'claude-code',
    identity: login.account,
    status: login.state === 'in' ? 'connected' : 'not-configured',
  }
}

/** Native Codex / ChatGPT login (~/.codex/auth.json). */
function detectCodex(homeDir: string): AccountView {
  const login = detectCodexLogin(homeDir)
  const present = login.state === 'in'
  const identity = present
    ? login.account
      ? `ChatGPT · ${maskCredential(login.account)}`
      : 'ChatGPT subscription'
    : undefined
  return {
    id: 'native:codex',
    provider: 'openai',
    source: 'native',
    harness: 'codex',
    identity,
    status: present ? 'connected' : 'not-configured',
  }
}

/** Native Grok login (~/.grok). Presence-only; the CLI owns the credential. */
function detectGrok(homeDir: string): AccountView {
  const present = detectGrokLogin(homeDir).state === 'in'
  return {
    id: 'native:grok',
    provider: 'xai',
    source: 'native',
    harness: 'grok',
    identity: present ? 'Grok login' : undefined,
    status: present ? 'connected' : 'not-configured',
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
  const native = [detectClaude(homeDir), detectCodex(homeDir), detectGrok(homeDir)]

  // Managed rows: a stored credential (#216) wins; otherwise fall back to the
  // legacy settings.apiKeys value so an existing key keeps showing as connected.
  const stored = new Map(accounts.list().map((a) => [a.id, a]))
  const managed: AccountView[] = MANAGED_KEY_PROVIDERS.map((provider) => {
    const id = `managed:${provider}`
    const row = stored.get(id)
    const legacyKey = settings.apiKeys[provider] ?? ''
    const identity = row?.identity || (legacyKey ? maskCredential(legacyKey) : undefined)
    return {
      id,
      provider,
      source: 'managed' as const,
      kind: 'api-key' as const,
      identity,
      status: identity ? ('connected' as const) : ('not-configured' as const),
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
    identity: oauthRow?.identity,
    status: oauthRow ? 'connected' : 'not-configured',
  }

  return [...native, ...managed, claudeOauth]
}
