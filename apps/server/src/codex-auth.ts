import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmConfigError } from './llm'

/**
 * Reuse the local ChatGPT login that the Codex CLI maintains in
 * `~/.codex/auth.json`, instead of shelling out to `codex exec`. The superagent's
 * `codex` API provider calls the Codex backend's Responses API directly with this
 * OAuth access token — same thing Hermes does. We never run the CLI.
 *
 * Access tokens are short-lived JWTs (~1h). Codex refreshes them via the public
 * PKCE client below; we do the same and write the rotated tokens back atomically
 * so the next CLI/Podium read sees them. The client id is the Codex CLI's public
 * identifier (not a secret) and the token endpoint is OpenAI's hosted OAuth.
 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
/** Refresh when the token expires within this window (or is already expired). */
const EXPIRY_SKEW_MS = 60_000

type FetchLike = typeof fetch

interface AuthFile {
  tokens?: {
    access_token?: string
    id_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
  [k: string]: unknown
}

export interface CodexAuth {
  accessToken: string
  /** Sent as the `chatgpt-account-id` header — the backend requires it. */
  accountId: string
}

function codexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex')
}

export function codexAuthPath(): string {
  return join(codexHome(), 'auth.json')
}

/** Cheap sync check so the client factory can fail fast with a clear message. */
export function codexLoginPresent(): boolean {
  try {
    if (!existsSync(codexAuthPath())) return false
    const f = readFileSync(codexAuthPath(), 'utf8')
    const parsed = JSON.parse(f) as AuthFile
    return Boolean(parsed.tokens?.access_token && parsed.tokens?.refresh_token)
  } catch {
    return false
  }
}

function readAuthFile(): AuthFile {
  let raw: string
  try {
    raw = readFileSync(codexAuthPath(), 'utf8')
  } catch {
    throw new LlmConfigError(
      `Codex isn't logged in on this server — run \`codex login\` (looked in ${codexAuthPath()}).`,
    )
  }
  try {
    return JSON.parse(raw) as AuthFile
  } catch {
    throw new LlmConfigError(`Codex auth file is corrupt: ${codexAuthPath()}`)
  }
}

/** Decode a JWT's `exp` (seconds) without verifying — we only need the clock. */
function jwtExpMs(token: string): number | undefined {
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

function authFromFile(file: AuthFile): CodexAuth {
  const accessToken = file.tokens?.access_token
  const accountId = file.tokens?.account_id
  if (!accessToken) {
    throw new LlmConfigError('Codex login has no access token — run `codex login` again.')
  }
  if (!accountId) {
    throw new LlmConfigError('Codex login has no account id — run `codex login` again.')
  }
  return { accessToken, accountId }
}

/** Atomic write so a concurrent CLI/Podium reader never sees a half-written file. */
function writeAuthFile(file: AuthFile): void {
  const path = codexAuthPath()
  const tmp = `${path}.podium.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

async function refresh(fetchImpl: FetchLike, file: AuthFile): Promise<AuthFile> {
  const refreshToken = file.tokens?.refresh_token
  if (!refreshToken) {
    throw new LlmConfigError('Codex login has no refresh token — run `codex login` again.')
  }
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new LlmConfigError(
      `Couldn't refresh the Codex token (${res.status}). Run \`codex login\` again. ${body.slice(0, 200)}`,
    )
  }
  const data = (await res.json()) as {
    access_token?: string
    id_token?: string
    refresh_token?: string
  }
  if (!data.access_token) {
    throw new LlmConfigError('Codex token refresh returned no access token.')
  }
  const next: AuthFile = {
    ...file,
    tokens: {
      ...file.tokens,
      access_token: data.access_token,
      ...(data.id_token ? { id_token: data.id_token } : {}),
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    },
    last_refresh: new Date().toISOString(),
  }
  writeAuthFile(next)
  return next
}

/**
 * Resolve a usable token, refreshing proactively when it's near expiry. Pass
 * `force` after a 401 to refresh regardless of the local clock.
 */
export async function resolveCodexAuth(
  fetchImpl: FetchLike = fetch,
  opts: { force?: boolean } = {},
): Promise<CodexAuth> {
  let file = readAuthFile()
  const token = file.tokens?.access_token
  const expMs = token ? jwtExpMs(token) : undefined
  const stale = opts.force || !token || expMs === undefined || expMs - Date.now() < EXPIRY_SKEW_MS
  if (stale) file = await refresh(fetchImpl, file)
  return authFromFile(file)
}
