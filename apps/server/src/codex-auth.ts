import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmConfigError } from './llm'

/**
 * Reuse the local ChatGPT login that the Codex CLI maintains in
 * `~/.codex/auth.json`, instead of shelling out to `codex exec`. The superagent's
 * `codex` API provider calls the Codex backend's Responses API directly with this
 * OAuth access token. We never run the CLI.
 *
 * Read-only on purpose. OAuth refresh tokens are single-use (rotated on every
 * refresh), so a second refresher racing the Codex CLI over the same auth.json
 * leaves whichever side loses holding an already-used token — which permanently
 * wedges the login until `codex login` (the documented codex race, openai/codex
 * #10332; Hermes inherits the same bug). So Podium never refreshes or writes this
 * file: it uses the CLI-maintained access token while valid, always re-reads the
 * file fresh so it picks up whatever the CLI last rotated to, and surfaces an
 * actionable error when expired rather than rotating the shared credential.
 */

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

/**
 * Resolve a usable token from the CLI-maintained auth file. We never refresh —
 * see the module header. Each call re-reads the file, so a token a concurrent
 * codex session has rotated in is picked up automatically. After a 401, pass the
 * just-rejected token as `rejectedAccessToken`: if that same value is still
 * sitting in the file we treat it as unusable (and surface an error) instead of
 * handing it back into a retry loop; if the file now holds a different, valid
 * token (the CLI rotated it), that one is used and the retry self-heals.
 *
 * `_fetchImpl` is accepted for call-site compatibility but never used — this path
 * makes no network calls.
 */
export async function resolveCodexAuth(
  _fetchImpl: FetchLike = fetch,
  opts: { rejectedAccessToken?: string } = {},
): Promise<CodexAuth> {
  const file = readAuthFile()
  const token = file.tokens?.access_token
  const expMs = token ? jwtExpMs(token) : undefined
  const expired = !token || (expMs !== undefined && expMs <= Date.now())
  const rejected = opts.rejectedAccessToken !== undefined && token === opts.rejectedAccessToken
  if (!expired && !rejected) return authFromFile(file)
  throw new LlmConfigError(
    "Codex access token is expired and Podium won't refresh it — refresh tokens are " +
      'single-use, and rotating one here would invalidate your Codex CLI sessions. Open a ' +
      'Codex session or run `codex login` to refresh it, then retry.',
  )
}
