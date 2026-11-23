/**
 * Pi credentials — the Inventory credentials section (POD-4414 §4.4,
 * issue 3.3; managed installs §4.7, POD-7372).
 *
 * KNOWLEDGE, not mechanism: Pi keeps every provider login (OAuth and API
 * keys) in `auth.json` in its agent folder, `~/.pi/agent` unless
 * `PI_CODING_AGENT_DIR` moves it. That variable moves the whole folder:
 * `auth.json`, `settings.json`, the model store and the sessions (POD-7267).
 * Declaring the file here is what gives Pi a Podium home: the home variable
 * is read from this declaration (`harnessHomeVariable`).
 *
 * Never propagated between machines: a Pi login is several providers' tokens
 * in one file, and nothing orders two copies of it.
 */
import { createHash } from 'node:crypto'
import { type CredentialFileReader, type HarnessCredentials, unsupported } from '../../manifest.js'

/** Pi's agent folder relative to the account home. */
export const PI_AGENT_DIR = '.pi/agent'

interface PiAuthRecord {
  type?: unknown
  key?: unknown
  access?: unknown
  refresh?: unknown
}

export function parsePiAuth(contents: string): Record<string, PiAuthRecord> | undefined {
  try {
    const parsed: unknown = JSON.parse(contents)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, PiAuthRecord>)
      : undefined
  } catch {
    return undefined
  }
}

/** The providers `auth.json` holds a usable-looking credential for, sorted. */
export function credentialedPiProviders(auth: Record<string, PiAuthRecord>): string[] {
  return Object.entries(auth)
    .filter(([, record]) => record && (record.key || record.access || record.refresh))
    .map(([provider]) => provider)
    .sort()
}

/** A stable identity for the stored credential set: which providers, and a hash
 *  of each credential — never the credential itself. Changes when the user
 *  re-authenticates, which is exactly when a tool-less headless account must be
 *  re-verified before launch. */
export function piIdentityOf(read: CredentialFileReader) {
  const raw = read(PI_AGENT_DIR, 'auth.json')
  const auth = raw ? parsePiAuth(raw) : undefined
  if (!auth) return undefined
  const providers = credentialedPiProviders(auth)
  if (providers.length === 0) return undefined
  const digest = createHash('sha256')
  for (const provider of providers) {
    digest.update(provider)
    digest.update(':')
    digest.update(createHash('sha256').update(JSON.stringify(auth[provider])).digest('hex'))
    digest.update('\n')
  }
  return { fingerprint: digest.digest('hex'), providerAccountId: providers.join(',') }
}

export const piCredentials: HarnessCredentials = {
  kinds: ['pi'],
  files: [
    {
      kind: 'pi',
      dirName: PI_AGENT_DIR,
      fileName: 'auth.json',
      homeEnvVar: 'PI_CODING_AGENT_DIR',
      propagatable: false,
      validate: (contents) => {
        const auth = parsePiAuth(contents)
        return auth !== undefined && credentialedPiProviders(auth).length > 0
      },
      freshness: () => undefined,
      compareFreshness: () => null,
    },
  ],
  identity: piIdentityOf,
  transfer: unsupported('Pi credentials live in a plain file; no platform transfer applies'),
}
