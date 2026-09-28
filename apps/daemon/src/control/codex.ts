import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexResponsesBody,
  type CodexEffort,
  CODEX_RESPONSES_URL,
  codexAccessTokenExpiryMs,
  CodexHttpError,
  codexResponsesHeaders,
  hasValidCodexCredential,
  parseCodexAuthContents,
  parseCodexResponsesSse,
  truncateCodexError,
} from '@podium/harness'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { HarnessManagementContext } from '../harness-management.js'
import { resolveManagementCredentialHome } from '../harness-management.js'
import type { ControlHandlers } from './context'

/**
 * Server-side LLM over this machine's Codex login (POD-4750).
 *
 * The server names the machine from its login catalog; THIS daemon performs
 * the Codex Responses API call with the CLI-maintained token and returns ONLY
 * the model's reply. The token never leaves this machine.
 *
 * Read-only on purpose. OAuth refresh tokens are single-use (rotated on every
 * refresh), so a second refresher racing the Codex CLI over the same auth.json
 * leaves whichever side loses holding an already-used token — which permanently
 * wedges the login until `codex login` (the documented codex race,
 * openai/codex #10332; Hermes inherits the same bug). So the daemon never
 * refreshes or writes this file: it uses the CLI-maintained access token while
 * valid, always re-reads the file fresh so it picks up whatever the CLI last
 * rotated to, and surfaces an actionable error when expired rather than
 * rotating the shared credential. Moved verbatim from
 * `apps/server/src/codex-auth.ts` (deleted); only WHERE the file is read moved.
 */

type FetchLike = typeof fetch

export interface CodexDaemonAuth {
  accessToken: string
  /** Sent as the `chatgpt-account-id` header — the backend requires it. */
  accountId: string
}

/**
 * The daemon's own HTTPS budget (POD-4750 coordinator review: TWO TIMEOUTS).
 * Shorter than the server broker's 125 s so a slow model comes back as this
 * machine's clear "model timed out" error instead of the server wrongly
 * reporting the machine offline.
 */
export const CODEX_DAEMON_HTTP_TIMEOUT_MS = 110_000

function codexHome(credentialHome: string | undefined): string {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0) return process.env.CODEX_HOME
  return join(credentialHome ?? homedir(), '.codex')
}

export function codexAuthPathFor(credentialHome: string | undefined): string {
  return join(codexHome(credentialHome), 'auth.json')
}

/** Cheap sync check so the handler can fail fast with a clear message. */
export function codexLoginPresentOnHost(credentialHome: string | undefined): boolean {
  try {
    const path = codexAuthPathFor(credentialHome)
    if (!existsSync(path)) return false
    return hasValidCodexCredential(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

function readAuthContents(credentialHome: string | undefined): string {
  const path = codexAuthPathFor(credentialHome)
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new CodexDaemonAuthError(
      `Codex isn't logged in on this machine — run \`codex login\` (looked in ${path}).`,
    )
  }
}

/** Actionable, credential-free failure — safe to send back to the server. */
export class CodexDaemonAuthError extends Error {}

/**
 * Resolve a usable token from the CLI-maintained auth file. Never refreshes —
 * see the module header. Each call re-reads the file, so a token a concurrent
 * codex session has rotated in is picked up automatically. After a 401, pass
 * the just-rejected token as `rejectedAccessToken`: if that same value is
 * still sitting in the file it is treated as unusable (and surfaces an error)
 * instead of looping; if the file now holds a different, valid token (the CLI
 * rotated it), that one is used and the retry self-heals.
 */
export async function resolveCodexDaemonAuth(
  credentialHome: string | undefined,
  opts: { rejectedAccessToken?: string } = {},
): Promise<CodexDaemonAuth> {
  const contents = readAuthContents(credentialHome)
  try {
    JSON.parse(contents)
  } catch {
    throw new CodexDaemonAuthError(`Codex auth file is corrupt: ${codexAuthPathFor(credentialHome)}`)
  }
  const parsed = parseCodexAuthContents(contents)
  const token = parsed?.accessToken
  const expMs = token ? codexAccessTokenExpiryMs(token) : undefined
  const expired = !token || (expMs !== undefined && expMs <= Date.now())
  const rejected = opts.rejectedAccessToken !== undefined && token === opts.rejectedAccessToken
  if (!expired && !rejected && parsed) return parsed
  throw new CodexDaemonAuthError(
    "Codex access token is expired and Podium won't refresh it — refresh tokens are " +
      'single-use, and rotating one here would invalidate your Codex CLI sessions. Open a ' +
      'Codex session or run `codex login` to refresh it, then retry.',
  )
}

export type CodexCompleteOutcome =
  | { ok: true; text: string; toolCalls: { id: string; name: string; arguments: string }[] }
  | { ok: false; error: string }

/**
 * Run one Responses turn against this machine's login. Injectable fetch +
 * credential home make this unit-testable without a daemon: production passes
 * the global fetch and the management credential home.
 */
export async function runCodexComplete(
  deps: { credentialHome: string | undefined; fetchImpl?: FetchLike; timeoutMs?: number },
  msg: Extract<ControlMessage, { type: 'codexCompleteRequest' }>,
): Promise<CodexCompleteOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? CODEX_DAEMON_HTTP_TIMEOUT_MS
  const effort: CodexEffort = msg.effort
  let auth: CodexDaemonAuth
  try {
    auth = await resolveCodexDaemonAuth(deps.credentialHome)
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
  const attempt = async (token: CodexDaemonAuth) => {
    const res = await fetchWithDaemonTimeout(
      fetchImpl,
      CODEX_RESPONSES_URL,
      {
        method: 'POST',
        headers: codexResponsesHeaders(token),
        body: JSON.stringify(buildCodexResponsesBody(msg.model, msg.messages, msg.tools, effort)),
      },
      timeoutMs,
    )
    if (!res.ok) {
      throw new CodexHttpError(res.status, `codex ${res.status}: ${truncateCodexError(await res.text(), 400)}`)
    }
    return parseCodexResponsesSse(await res.text())
  }
  try {
    const first = await attempt(auth)
    return { ok: true as const, text: first.text, toolCalls: first.toolCalls }
  } catch (err) {
    if (err instanceof CodexHttpError && err.status === 401) {
      // The token was rejected. Re-read once: a concurrent CLI session may
      // have rotated a fresh one in (self-heal); if the same value is still
      // there it is unusable — surface, never loop.
      try {
        const rotated = await resolveCodexDaemonAuth(deps.credentialHome, {
          rejectedAccessToken: auth.accessToken,
        })
        const second = await attempt(rotated)
        return { ok: true as const, text: second.text, toolCalls: second.toolCalls }
      } catch (retryErr) {
        return {
          ok: false as const,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        }
      }
    }
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchWithDaemonTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`codex model timed out after ${Math.round(ms / 1000)}s — ${url}`)
    }
    throw err
  }
}

async function handleCodexComplete(
  ctx: HarnessManagementContext,
  msg: Extract<ControlMessage, { type: 'codexCompleteRequest' }>,
): Promise<void> {
  const credentialHome = resolveManagementCredentialHome(ctx)
  const outcome = await runCodexComplete({ credentialHome }, msg)
  ctx.send({
    type: 'codexCompleteResult',
    requestId: msg.requestId,
    ok: outcome.ok,
    ...(outcome.ok
      ? { text: outcome.text, toolCalls: outcome.toolCalls }
      : { error: outcome.error }),
  })
}

export const codexHandlers: Pick<ControlHandlers, 'codexCompleteRequest'> = {
  codexCompleteRequest: (ctx, msg) => {
    void handleCodexComplete(ctx, msg)
  },
}
