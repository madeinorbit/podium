import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type OpencodeLogin = {
  state: 'in' | 'out'
  account?: string
}

/**
 * WHERE THE CREDENTIAL LIVES under a given home.
 *
 * Exported because {@link detectOpencodeLogin} is no longer the only thing that
 * needs it: a lane running the daemon against an ISOLATED home has to WRITE the
 * file this module READS, and a hand-copied path in a test helper is a path
 * that can drift from this one (POD-2772). Ask for it instead.
 *
 * Deliberately not routed through `opencodeDataRoot` in `./db.js`, near though
 * that is: this module is what `apps/server`'s Accounts hub reaches for through
 * `harnessDetectLogin`, and `db.js` pulls SQLite in behind it. The duplicated
 * segment is the cheaper of the two costs.
 */
export function opencodeAuthPath(homeDir: string): string {
  return join(homeDir, '.local', 'share', 'opencode', 'auth.json')
}

/**
 * OpenCode keeps provider credentials in its data root rather than a
 * provider-specific home directory. Only provider names are returned to the
 * inventory; credential values never leave this function.
 *
 * `out` MEANS "NO USABLE CREDENTIAL UNDER THIS HOME" — not "the user pressed
 * log out". A home that has never been logged in to, a home whose auth.json was
 * deleted, and a genuinely logged-out one are the same fact here on purpose:
 * they need the same remedy, and nothing downstream could act on the
 * difference. Callers that hand this function an EMPTY home (a hermetic test
 * home, a freshly provisioned instance home) are therefore told the truth, and
 * a server-family session started under that home really would have no
 * credential to answer with. [POD-2772]
 */
export function detectOpencodeLogin(homeDir: string): OpencodeLogin {
  try {
    const parsed: unknown = JSON.parse(readFileSync(opencodeAuthPath(homeDir), 'utf8'))
    if (!isRecord(parsed)) return { state: 'out' }
    const providers = Object.entries(parsed)
      .filter(([, value]) => hasCredential(value))
      .map(([provider]) => provider)
      .sort()
    if (providers.length === 0) return { state: 'out' }
    return {
      state: 'in',
      account: `OpenCode · ${providers.join(', ')}`,
    }
  } catch {
    return { state: 'out' }
  }
}

function hasCredential(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).some(
    ([key, field]) => key !== 'type' && typeof field === 'string' && field.trim().length > 0,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
