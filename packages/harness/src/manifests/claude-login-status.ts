import { fingerprintForLoginIdentity } from '../codex-auth-identity.js'
import type { LoginCommandDecision, LoginCommandResult } from '../manifest.js'

const OUTPUT_LIMIT_ERROR = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
const UNSUPPORTED_STATUS_COMMAND = "error: unknown command 'status'"

function unknown(reason: string): LoginCommandDecision {
  return { kind: 'unknown', reason }
}

function isKeychainFailure(stderr: string): boolean {
  const message = stderr.toLowerCase()
  return (
    message.includes('keychain') ||
    message.includes('secure storage') ||
    message.includes('security interaction is not allowed') ||
    message.includes('user interaction is not allowed') ||
    message.includes('errsecinteractionnotallowed') ||
    message.includes('errsecauthfailed')
  )
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean || undefined
}

/** Pure classification for Claude's machine-readable auth status result. */
export function classifyClaudeLoginStatus(result: LoginCommandResult): LoginCommandDecision {
  if (result.timedOut) return unknown('timeout')
  if (result.signal) return unknown('signal')
  if (result.errorCode === OUTPUT_LIMIT_ERROR) return unknown('output-limit')
  if (result.errorCode) return unknown('launch')

  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (isKeychainFailure(stderr)) return unknown('keychain')

  // Claude Code 2.1.50 emits this exact, lower-case Commander diagnostic for
  // an unrecognized nested auth subcommand. Match only the missing status
  // spelling, an empty stdout, and its exit 1 so ordinary auth failures cannot
  // reactivate the credential-file detector.
  if (result.exitCode === 1 && !stdout && stderr === UNSUPPORTED_STATUS_COMMAND) {
    return { kind: 'fallback' }
  }

  if (result.exitCode !== 0 && result.exitCode !== 1) return unknown('exit-code')

  let document: unknown
  try {
    document = JSON.parse(stdout)
  } catch {
    return unknown('parse')
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return unknown('shape')
  }

  const status = document as Record<string, unknown>
  if (typeof status.loggedIn !== 'boolean') return unknown('logged-in-flag')
  if (status.loggedIn && result.exitCode === 0) {
    const email = cleanString(status.email)
    const orgName = cleanString(status.orgName)
    return {
      kind: 'determined',
      login: {
        state: 'in',
        account: email ?? orgName ?? 'Claude login',
        ...(email ? { identity: { fingerprint: fingerprintForLoginIdentity(email), email } } : {}),
      },
    }
  }
  if (!status.loggedIn && result.exitCode === 1) {
    return { kind: 'determined', login: { state: 'out' } }
  }
  return unknown('exit-status-mismatch')
}
