/**
 * Grok credential file — the Inventory credentials section (POD-4414 §4.4,
 * issue 3.3).
 *
 * KNOWLEDGE, not mechanism: `~/.grok/auth.json` backs the portable `grok`
 * bundle. Grok credentials never propagate between machines (the guarded
 * propagation set is Claude and Codex only), so freshness is unprovable by
 * declaration — exactly as the old file backend behaved.
 */
import { fingerprintForLoginIdentity } from '../shared/login-identity.js'
import { unsupported, type HarnessCredentials } from '../../manifest.js'

interface GrokAuthRecord {
  key?: unknown
  refresh_token?: unknown
  create_time?: unknown
  expires_at?: unknown
  email?: unknown
  account_id?: unknown
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function expiryMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * One auth.json entry is usable while its key is live, or while a refresh
 * token can renew it. Grok refreshes the OIDC key itself against
 * `oidc_issuer` before `expires_at` (and on 401/403 retry-once), rewriting
 * auth.json — so an expired key WITH a refresh token stays ready. An expired
 * key with no refresh token is a lapsed login: nothing can renew it.
 * A missing or unparseable `expires_at` stays usable (conservative: never
 * log out a login whose clock we cannot read).
 */
export function isUsableGrokAuthRecord(record: GrokAuthRecord, nowMs = Date.now()): boolean {
  if (nonEmptyString(record.refresh_token)) return true
  if (!nonEmptyString(record.key)) return false
  const expires = expiryMs(record.expires_at)
  if (expires === undefined) return true
  return expires > nowMs
}

/** A Grok auth file is usable when some entry carries a usable token. */
export function hasValidGrokCredential(contents: string, nowMs = Date.now()): boolean {
  const file = parseAuthFile(contents)
  if (!file) return false
  return Object.values(file).some(
    (record) => record && isUsableGrokAuthRecord(record, nowMs),
  )
}

function parseAuthFile(contents: string): Record<string, GrokAuthRecord> | undefined {
  try {
    const parsed: unknown = JSON.parse(contents)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, GrokAuthRecord>)
      : undefined
  } catch {
    return undefined
  }
}

function newestRecord(file: Record<string, GrokAuthRecord>): GrokAuthRecord | undefined {
  return Object.values(file)
    .filter((record) => record && (record.key || record.refresh_token))
    .sort((left, right) => String(right.create_time ?? '').localeCompare(String(left.create_time ?? '')))[0]
}

export const grokCredentials: HarnessCredentials = {
  kinds: ['grok'],
  files: [
    {
      kind: 'grok',
      dirName: '.grok',
      fileName: 'auth.json',
      homeEnvVar: 'GROK_HOME',
      propagatable: false,
      validate: hasValidGrokCredential,
      freshness: () => undefined,
      compareFreshness: () => null,
    },
  ],
  identity: (read) => {
    const raw = read('.grok', 'auth.json')
    const file = raw ? parseAuthFile(raw) : undefined
    const record = file ? newestRecord(file) : undefined
    if (!record) return undefined
    const email = typeof record.email === 'string' ? record.email.trim() : ''
    const providerAccountId =
      typeof record.account_id === 'string' ? record.account_id.trim() : ''
    const source = providerAccountId || email
    return source
      ? {
          fingerprint: fingerprintForLoginIdentity(source),
          ...(email ? { email } : {}),
          ...(providerAccountId ? { providerAccountId } : {}),
        }
      : undefined
  },
  transfer: unsupported('Grok credentials live in a plain file; no platform transfer applies'),
}
