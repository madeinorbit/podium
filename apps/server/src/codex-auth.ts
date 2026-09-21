import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  codexAccessTokenExpiryMs,
  hasValidCodexCredential,
  parseCodexAuthContents,
} from '@podium/harness/metadata'
import { LlmConfigError } from './llm-error'

/**
 * Reuse the local ChatGPT login that the Codex CLI maintains in
 * `~/.codex/auth.json`, instead of shelling out to `codex exec`. The superagent's
 * `codex` API provider calls the Codex backend's Responses API directly with this
 * OAuth access token. We never run the CLI.
 *
 * The auth FILE's shape — which fields carry the token pair, how the JWT clock
 * reads, what counts as a login — is owned by `@podium/harness` (the Codex
 * adapter's credentials section and its pure readers, via `metadata`). This
 * module keeps only what is genuinely server-side: reading the SERVER's own
 * file and the never-refresh policy with its actionable errors.
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

export interface CodexAuth {
  accessToken: string
  /** Sent as the `chatgpt-account-id` header — the backend requires it. */
  /** UNBRANDED BY DECISION: a provider account id, not a server-minted Podium AccountId. */
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
    return hasValidCodexCredential(readFileSync(codexAuthPath(), 'utf8'))
  } catch {
    return false
  }
}

function readAuthContents(): string {
  try {
    return readFileSync(codexAuthPath(), 'utf8')
  } catch {
    throw new LlmConfigError(
      `Codex isn't logged in on this server — run \`codex login\` (looked in ${codexAuthPath()}).`,
    )
  }
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
  const contents = readAuthContents()
  try {
    JSON.parse(contents)
  } catch {
    throw new LlmConfigError(`Codex auth file is corrupt: ${codexAuthPath()}`)
  }
  const parsed = parseCodexAuthContents(contents)
  const token = parsed?.accessToken
  const expMs = token ? codexAccessTokenExpiryMs(token) : undefined
  const expired = !token || (expMs !== undefined && expMs <= Date.now())
  const rejected = opts.rejectedAccessToken !== undefined && token === opts.rejectedAccessToken
  if (!expired && !rejected && parsed) return parsed
  throw new LlmConfigError(
    "Codex access token is expired and Podium won't refresh it — refresh tokens are " +
      'single-use, and rotating one here would invalidate your Codex CLI sessions. Open a ' +
      'Codex session or run `codex login` to refresh it, then retry.',
  )
}
