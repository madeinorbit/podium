import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type OpencodeLogin = {
  state: 'in' | 'out'
  account?: string
}

/**
 * OpenCode keeps provider credentials in its data root rather than a
 * provider-specific home directory. Only provider names are returned to the
 * inventory; credential values never leave this function.
 */
export function detectOpencodeLogin(homeDir: string): OpencodeLogin {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json'), 'utf8'),
    )
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
