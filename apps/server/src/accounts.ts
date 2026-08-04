// Account discovery for the Accounts & Keys settings hub (SP-6454, stream B2).
//
// Native login facts come from the authenticated machine inventory catalog. The
// server never reads a host-local HOME here: every machine contributes through
// its replicated, non-secret inventory record. Managed credentials remain in the
// server-only accounts table and only their masked identities are projected.

import { harnessDetectLogin } from '@podium/harness/metadata'
import type { HarnessAgent } from '@podium/model'
import type { AccountsRepository } from './store/accounts'
import { buildLoginCatalog, catalogEntriesForHarness, type LoginCatalog } from './login-catalog'
import type { MachineRecord } from './store/types'

/** A row in the Accounts hub. Native rows are observed from the machine catalog;
 * managed rows reflect what Podium stores. */
export interface AccountView {
  /** Stable id, e.g. "native:claude-code" or "native:claude-code:<fingerprint>". */
  id: string
  provider: string
  source: 'native' | 'managed'
  /** Managed only: how the credential would be injected. */
  kind?: 'api-key' | 'oauth'
  /** Native only: which harness login this is. */
  harness?: string
  /** Observed, human-facing: an email/plan, a masked key, or a hint. */
  identity?: string
  /** Native identities may be present on several machines. */
  machines?: string[]
  /** Non-secret identity fingerprint used to distinguish multiple native logins. */
  identityFingerprint?: string
  status: 'connected' | 'not-configured'
  /** Managed only: where the credential actually lives. */
  credentialSource?: 'stored' | 'legacy'
}

/** Display-only preview of a secret. The full value never leaves the server. */
export function maskCredential(secret: string): string {
  if (secret.length <= 8) return '""""'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/**
 * Compatibility seam for older unit tests that explicitly provide a HOME. Production
 * calls pass machine records, so this path is never reached by the account query.
 */
function detectNative(homeDir: string, kind: HarnessAgent, provider: string): AccountView {
  const login = harnessDetectLogin(kind, homeDir)
  if (!login) {
    return {
      id: `native:${kind}`,
      provider,
      source: 'native',
      harness: kind,
      status: 'not-configured',
    }
  }
  return {
    id: `native:${kind}`,
    provider,
    source: 'native',
    harness: kind,
    identity: login.account,
    status: login.state === 'in' ? 'connected' : 'not-configured',
  }
}

const NATIVE_HARNESSES: readonly [HarnessAgent, string][] = [
  ['claude-code', 'anthropic'],
  ['codex', 'openai'],
  ['grok', 'xai'],
]

function nativeFromCatalog(catalog: LoginCatalog): AccountView[] {
  return NATIVE_HARNESSES.flatMap(([harness, provider]): AccountView[] => {
    const entries = catalogEntriesForHarness(catalog, harness)
    if (entries.length === 0) {
      return [
        {
          id: `native:${harness}`,
          provider,
          source: 'native' as const,
          harness,
          status: 'not-configured' as const,
        },
      ]
    }
    return entries.map((entry) => ({
      id: entries.length === 1 ? `native:${harness}` : `native:${harness}:${entry.fingerprint}`,
      provider,
      source: 'native' as const,
      harness,
      identity: entry.email ?? entry.providerAccountId,
      machines: [
        ...new Set(
          entry.machines
            .filter((machine) => machine.harness === harness)
            .map((machine) => machine.machineName),
        ),
      ],
      identityFingerprint: entry.fingerprint,
      status: 'connected' as const,
    }))
  })
}

const MANAGED_KEY_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const

/**
 * All accounts for the hub: the catalog of native CLI logins plus the managed
 * credentials Podium holds. Managed rows are read from the accounts table, never
 * from the settings blob, so credential bytes cannot reach a client.
 *
 * The third argument accepts an explicit HOME only for legacy unit tests. The
 * production query passes machine records and therefore has no homedir fallback.
 */
export function accountViews(
  legacyApiKey: (provider: string) => string | undefined,
  accounts: AccountsRepository,
  machinesOrHome: readonly MachineRecord[] | string = [],
): AccountView[] {
  const native =
    typeof machinesOrHome === 'string'
      ? [
          detectNative(machinesOrHome, 'claude-code', 'anthropic'),
          detectNative(machinesOrHome, 'codex', 'openai'),
          detectNative(machinesOrHome, 'grok', 'xai'),
        ]
      : nativeFromCatalog(buildLoginCatalog(machinesOrHome))

  const stored = new Map(accounts.list().map((a) => [a.id, a]))
  const managed: AccountView[] = MANAGED_KEY_PROVIDERS.map((provider) => {
    const id = `managed:${provider}`
    const row = stored.get(id)
    const legacyKey = legacyApiKey(provider) ?? ''
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
