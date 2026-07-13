/**
 * Per-harness login/credential detectors (#222) — extracted from
 * apps/server/src/accounts.ts and parameterized by an explicit homeDir, because
 * a daemon reports about ITS OWN machine, not the server's. Read-only,
 * best-effort: every failure degrades to 'out' (or 'unknown' for kinds with no
 * detector), never throws.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessAgent } from '@podium/protocol'

/** Normalized login status for one harness on one machine. */
export interface HarnessLogin {
  state: 'in' | 'out' | 'unknown'
  /** Email / account label when known (claude email, codex account id). */
  account?: string
}

/** Native Claude Code login: email lives in ~/.claude.json (oauthAccount),
 *  separate from the credential token. Best-effort. */
export function detectClaudeLogin(homeDir: string): HarnessLogin {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string }
    }
    const email = raw.oauthAccount?.emailAddress
    if (email) return { state: 'in', account: email }
  } catch {
    // fall through — no readable login
  }
  return { state: 'out' }
}

/** Where the Codex CLI keeps its ChatGPT login. $CODEX_HOME wins (matches the
 *  CLI), else ~/.codex under the given home. */
export function codexAuthPath(homeDir: string): string {
  const codexHome =
    process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
      ? process.env.CODEX_HOME
      : join(homeDir, '.codex')
  return join(codexHome, 'auth.json')
}

/** Native Codex / ChatGPT login (auth.json with both tokens present). */
export function detectCodexLogin(homeDir: string): HarnessLogin {
  try {
    const path = codexAuthPath(homeDir)
    if (!existsSync(path)) return { state: 'out' }
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      tokens?: { access_token?: string; refresh_token?: string; account_id?: string }
    }
    if (!file.tokens?.access_token || !file.tokens?.refresh_token) return { state: 'out' }
    const account = file.tokens.account_id
    return { state: 'in', ...(account ? { account } : {}) }
  } catch {
    return { state: 'out' }
  }
}

/** Native Grok login (~/.grok or $GROK_HOME). Presence-only; the CLI owns the
 *  credential, so there is no account label to surface. */
export function detectGrokLogin(homeDir: string): HarnessLogin {
  const grokHome =
    process.env.GROK_HOME && process.env.GROK_HOME.length > 0
      ? process.env.GROK_HOME
      : join(homeDir, '.grok')
  return { state: existsSync(grokHome) ? 'in' : 'out' }
}

/** Login status for any harness kind. opencode + cursor have no credential
 *  detector today → honest 'unknown' rather than a lying boolean. */
export function detectHarnessLogin(kind: HarnessAgent, homeDir: string): HarnessLogin {
  switch (kind) {
    case 'claude-code':
      return detectClaudeLogin(homeDir)
    case 'codex':
      return detectCodexLogin(homeDir)
    case 'grok':
      return detectGrokLogin(homeDir)
    case 'opencode':
    case 'cursor':
      return { state: 'unknown' }
  }
}
