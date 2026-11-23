import { fingerprintForLoginIdentity } from '../adapters/shared/login-identity.js'
import type { LoginCommandResult, ReportedAuth } from '../manifest.js'

/**
 * WHICH LOGIN CLAUDE CODE IS ON, in its own words (credential management §9
 * "Launching"): `claude auth status` prints JSON. Measured on 2.1.323:
 *
 * - `authMethod: "claude.ai"` with `email`: the subscription login in its home;
 * - `authMethod: "api_key"` with `apiKeySource: "ANTHROPIC_API_KEY"`: a key,
 *   and the variable it came from;
 * - `authMethod: "oauth_token"`: a long-lived token, which Claude Code reads
 *   from `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * Anything else, or output that does not parse, is `unknown`.
 */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

export function classifyClaudeAuthStatus(result: LoginCommandResult): ReportedAuth {
  if (result.timedOut || result.errorCode || result.exitCode !== 0) return { method: 'unknown' }
  let status: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { method: 'unknown' }
    status = parsed as Record<string, unknown>
  } catch {
    return { method: 'unknown' }
  }
  if (status.loggedIn !== true) return { method: 'unknown' }
  const text = (key: string): string | undefined => {
    const value = status[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  switch (text('authMethod')) {
    case 'claude.ai': {
      const email = text('email')
      return {
        method: 'subscription',
        ...(email ? { email, fingerprint: fingerprintForLoginIdentity(email) } : {}),
      }
    }
    case 'api_key': {
      const source = text('apiKeySource')
      return {
        method: 'api-key',
        ...(source && ENV_NAME.test(source) ? { sourceVariable: source } : {}),
      }
    }
    case 'oauth_token':
      return { method: 'token', sourceVariable: 'CLAUDE_CODE_OAUTH_TOKEN' }
    default:
      return { method: 'unknown' }
  }
}
