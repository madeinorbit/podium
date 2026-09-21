/**
 * Grok credential file — the Inventory credentials section (POD-4414 §4.4,
 * issue 3.3).
 *
 * KNOWLEDGE, not mechanism: `~/.grok/auth.json` backs the portable `grok`
 * bundle. Grok credentials never propagate between machines (the guarded
 * propagation set is Claude and Codex only), so freshness is unprovable by
 * declaration — exactly as the old file backend behaved.
 */
import { fingerprintForLoginIdentity } from '../../codex-auth-identity.js'
import { unsupported, type HarnessCredentials } from '../../manifest.js'

interface GrokAuthRecord {
  key?: unknown
  refresh_token?: unknown
  create_time?: unknown
  email?: unknown
  account_id?: unknown
}

/** A Grok auth file is usable when some entry carries a token. */
export function hasValidGrokCredential(contents: string): boolean {
  const file = parseAuthFile(contents)
  if (!file) return false
  return Object.values(file).some(
    (record) => record && (record.key || record.refresh_token),
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
