// Account discovery for the Accounts & Keys settings hub (SP-6454, stream B2).
//
// Makes auth first-class and VISIBLE: native CLI logins on this machine (Claude
// Code, Codex/ChatGPT, Grok) shown read-only with their identity, alongside the
// managed API keys already stored in settings. MANAGED credential injection into
// harnesses + oauth rotation are modelled but ship "Coming soon" — this slice
// only detects + displays; it never writes a credential.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PodiumSettings } from '@podium/core'
import { codexAuthPath, codexLoginPresent } from './codex-auth'

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
  let identity: string | undefined
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string }
    }
    identity = raw.oauthAccount?.emailAddress
  } catch {
    identity = undefined
  }
  return {
    id: 'native:claude-code',
    provider: 'anthropic',
    source: 'native',
    harness: 'claude-code',
    identity: identity ?? undefined,
    status: identity ? 'connected' : 'not-configured',
  }
}

/** Native Codex / ChatGPT login (~/.codex/auth.json). */
function detectCodex(): AccountView {
  let identity: string | undefined
  const present = codexLoginPresent()
  if (present) {
    try {
      const file = JSON.parse(readFileSync(codexAuthPath(), 'utf8')) as {
        tokens?: { account_id?: string }
      }
      const acct = file.tokens?.account_id
      identity = acct ? `ChatGPT · ${maskKey(acct)}` : 'ChatGPT subscription'
    } catch {
      identity = 'ChatGPT subscription'
    }
  }
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
  const grokHome =
    process.env.GROK_HOME && process.env.GROK_HOME.length > 0
      ? process.env.GROK_HOME
      : join(homeDir, '.grok')
  const present = existsSync(grokHome)
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
  const native = [detectClaude(homeDir), detectCodex(), detectGrok(homeDir)]
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
