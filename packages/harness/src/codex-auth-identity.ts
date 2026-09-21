import { createHash } from 'node:crypto'
import type { LoginIdentity } from './manifest.js'

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringClaim(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return text(value?.[key])
}

function numberClaim(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = value?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Hash an account id or email. The result is safe to replicate to clients. */
export function fingerprintForLoginIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Extract the usable OAuth token pair from a Codex auth.json snapshot.
 * Undefined when either half is missing — the caller maps that to its own
 * actionable error. Never refreshes: OAuth refresh tokens are single-use, so
 * a second refresher racing the Codex CLI wedges the login until `codex
 * login` (openai/codex#10332).
 */
export function parseCodexAuthContents(
  contents: string,
): { accessToken: string; accountId: string } | undefined {
  let file: { tokens?: { access_token?: unknown; account_id?: unknown } }
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    file = parsed as { tokens?: { access_token?: unknown; account_id?: unknown } }
  } catch {
    return undefined
  }
  const accessToken = text(file.tokens?.access_token)
  const accountId = text(file.tokens?.account_id)
  if (!accessToken || !accountId) return undefined
  return { accessToken, accountId }
}

/** Decode a JWT's `exp` (seconds) without verifying — only the clock is needed. */
export function codexAccessTokenExpiryMs(token: string): number | undefined {
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const exp = (JSON.parse(json) as { exp?: number }).exp
    return typeof exp === 'number' ? exp * 1000 : undefined
  } catch {
    return undefined
  }
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

  const tokens = asRecord(auth.tokens)
  const idToken = stringClaim(tokens, 'id_token') ?? stringClaim(tokens, 'idToken')
  const payload = decodeJson(idToken)
  const authClaims = asRecord(payload?.['https://api.openai.com/auth'])
  const profileClaims = asRecord(payload?.['https://api.openai.com/profile'])
  const email = stringClaim(payload, 'email') ?? stringClaim(profileClaims, 'email')
  const providerAccountId =
    stringClaim(tokens, 'account_id') ??
    stringClaim(tokens, 'accountId') ??
    stringClaim(authClaims, 'chatgpt_account_id') ??
    stringClaim(payload, 'chatgpt_account_id') ??
    stringClaim(payload, 'https://api.openai.com/auth.chatgpt_account_id') ??
    stringClaim(authClaims, 'workspace_account_id') ??
    stringClaim(payload, 'workspace_account_id')
  const source = providerAccountId ?? email
  if (!source) return undefined
  return {
    fingerprint: fingerprintForLoginIdentity(source),
    ...(email ? { email } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
  }
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
  const tokens = asRecord(auth.tokens)
  const idToken = stringClaim(tokens, 'id_token') ?? stringClaim(tokens, 'idToken')
  const payload = decodeJson(idToken)
  return (
    numberClaim(tokens, 'expires_at') ??
    numberClaim(tokens, 'expiresAt') ??
    numberClaim(tokens, 'expiry') ??
    numberClaim(tokens, 'expires') ??
    numberClaim(payload, 'exp') ??
    numberClaim(payload, 'iat')
  )
}

export function compareCodexAuthFreshness(a: string, b: string): -1 | 0 | 1 | null {
  const left = readFreshnessFromAuthContents(a)
  const right = readFreshnessFromAuthContents(b)
  if (left === undefined || right === undefined) return null
  return left < right ? -1 : left > right ? 1 : 0
}
