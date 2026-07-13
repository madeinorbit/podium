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

function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
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
      ? `ChatGPT · ${maskKey(login.account)}`
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
 * the managed API keys already in settings (functional for the API/one-shot
 * path). Managed oauth + harness credential injection are not enumerated here —
 * they surface as a "Coming soon" affordance in the UI.
 */
export function accountViews(settings: PodiumSettings, homeDir: string = homedir()): AccountView[] {
  const native = [detectClaude(homeDir), detectCodex(homeDir), detectGrok(homeDir)]
  const managed: AccountView[] = MANAGED_KEY_PROVIDERS.map((provider) => {
    const key = settings.apiKeys[provider] ?? ''
    return {
      id: `managed:${provider}`,
      provider,
      source: 'managed' as const,
      kind: 'api-key' as const,
      identity: key ? maskKey(key) : undefined,
      status: key ? ('connected' as const) : ('not-configured' as const),
    }
  })
  return [...native, ...managed]
}
