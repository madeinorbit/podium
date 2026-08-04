import { createHash } from 'node:crypto'
import type { LoginIdentity } from './manifest.js'

interface CodexClaims {
  email?: unknown
  chatgpt_account_id?: unknown
  workspace_account_id?: unknown
  exp?: unknown
  iat?: unknown
  [key: string]: unknown
}

interface CodexAuthFile {
  tokens?: {
    id_token?: unknown
    account_id?: unknown
    expires_at?: unknown
  }
  last_refresh?: unknown
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean || undefined
}

function decodeJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  const part = value.split('.')[1]
  if (!part) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function claim(claims: CodexClaims, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = text(claims[name])
    if (value) return value
  }
  return undefined
}

/** Hash an account id or email. The result is safe to replicate to clients. */
export function fingerprintForLoginIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Extract only provider identity claims from a Codex auth.json snapshot. */
export function readIdentityFromAuthContents(contents: string): LoginIdentity | undefined {
  let auth: CodexAuthFile
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    auth = parsed as CodexAuthFile
  } catch {
    return undefined
  }

  const tokens = auth.tokens
  const claims = decodeJson(tokens?.id_token) as CodexClaims | undefined
  const email = claims ? claim(claims, ['email']) : undefined
  const providerAccountId =
    (claims
      ? claim(claims, [
          'chatgpt_account_id',
          'workspace_account_id',
          'https://api.openai.com/auth.chatgpt_account_id',
          'https://api.openai.com/auth.workspace_account_id',
        ])
      : undefined) ?? text(tokens?.account_id)
  const source = providerAccountId ?? email
  if (!source) return undefined
  return {
    fingerprint: fingerprintForLoginIdentity(source),
    ...(email ? { email } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.trim() !== '') return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Return a comparable freshness marker without retaining credential material. */
export function readFreshnessFromAuthContents(contents: string): number | undefined {
  let auth: CodexAuthFile
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    auth = parsed as CodexAuthFile
  } catch {
    return undefined
  }
  const claims = decodeJson(auth.tokens?.id_token) as CodexClaims | undefined
  const values = [
    timestamp(auth.tokens?.expires_at),
    timestamp(claims?.exp),
    timestamp(claims?.iat),
    timestamp(auth.last_refresh),
  ].filter((value): value is number => value !== undefined)
  return values.length > 0 ? Math.max(...values) : undefined
}

export function compareCodexAuthFreshness(a: string, b: string): -1 | 0 | 1 | null {
  const left = readFreshnessFromAuthContents(a)
  const right = readFreshnessFromAuthContents(b)
  if (left === undefined || right === undefined) return null
  return left < right ? -1 : left > right ? 1 : 0
}
