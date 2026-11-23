import type { LoginCommandResult, ReportedAuth } from '../manifest.js'

/**
 * WHICH LOGIN CODEX IS ON, in its own words (credential management §9
 * "Launching"): `codex login status` prints one line. Measured on 0.167.2:
 * `Logged in using ChatGPT`, `Logged in using an API key - <masked>`, and
 * `Not logged in` (exit 1). It names no account and no variable, so a Codex
 * report carries the method only.
 */
export function classifyCodexLoginStatus(result: LoginCommandResult): ReportedAuth {
  if (result.timedOut || result.errorCode) return { method: 'unknown' }
  const text = `${result.stdout}\n${result.stderr}`
  if (/Logged in using ChatGPT/i.test(text)) return { method: 'subscription' }
  if (/Logged in using an API key/i.test(text)) return { method: 'api-key' }
  return { method: 'unknown' }
}
