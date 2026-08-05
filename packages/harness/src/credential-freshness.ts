function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function numberLike(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

function parseObject(contents: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(contents))
  } catch {
    return undefined
  }
}

/** A Codex auth file is usable when both halves of its refresh lineage exist. */
export function hasValidCodexCredential(contents: string): boolean {
  const tokens = record(parseObject(contents)?.tokens)
  return nonEmptyString(tokens?.access_token) && nonEmptyString(tokens?.refresh_token)
}

/** Claude's native OAuth file carries its login under claudeAiOauth. */
export function hasValidClaudeCredential(contents: string): boolean {
  const oauth = record(parseObject(contents)?.claudeAiOauth)
  return nonEmptyString(oauth?.accessToken) && nonEmptyString(oauth?.refreshToken)
}

/** Return a non-secret ordering marker from Claude's native credential file. */
export function readClaudeCredentialFreshness(contents: string): number | undefined {
  const oauth = record(parseObject(contents)?.claudeAiOauth)
  if (!oauth) return undefined
  for (const key of [
    'expiresAt',
    'refreshTokenExpiresAt',
    'expires_at',
    'updatedAt',
    'updated_at',
    'lastRefresh',
    'last_refresh',
  ]) {
    const value = numberLike(oauth[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** `null` means ordering is unprovable and therefore must never overwrite. */
export function compareClaudeCredentialFreshness(a: string, b: string): -1 | 0 | 1 | null {
  const left = readClaudeCredentialFreshness(a)
  const right = readClaudeCredentialFreshness(b)
  if (left === undefined || right === undefined) return null
  return left < right ? -1 : left > right ? 1 : 0
}
