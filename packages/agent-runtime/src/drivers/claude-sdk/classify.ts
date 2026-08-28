/** Classify a Claude Agent SDK turn failure without inventing reset times. */

export type ClaudeSdkFailureClass =
  | 'usage_limit'
  | 'rate_limit'
  | 'authentication'
  | 'provider-error'

export interface ClaudeSdkFailure {
  errorClass: ClaudeSdkFailureClass
  retryable: boolean
}

const SECRET =
  /(?:sk-ant-[A-Za-z0-9_-]+|\boat_[A-Za-z0-9_-]+|(?:Bearer|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)[=:\s]+\S+)/gi

/** Drop credential material from a provider/error string before it is stored. */
export function redactClaudeSdkFailureDetail(detail: string): string {
  const redacted = detail.replace(SECRET, '[redacted]').replace(/\s+/g, ' ').trim()
  return redacted.length > 1000 ? `${redacted.slice(0, 999)}…` : redacted
}

/**
 * Monthly spend is a usage cap, not a transient 429. Expired/invalid auth is a
 * login problem. Both are durable facts; neither should look like the other.
 */
export function classifyClaudeSdkFailure(detail: string): ClaudeSdkFailure {
  const text = detail.toLowerCase()
  if (
    /monthly spend|spend limit|usage limit|you'?ve hit your(?:\s+\w+)?\s+limit|quota (?:exceeded|exhausted)/.test(
      text,
    )
  ) {
    return { errorClass: 'usage_limit', retryable: false }
  }
  if (/\b429\b|rate.?limit|too many requests/.test(text)) {
    return { errorClass: 'rate_limit', retryable: true }
  }
  if (
    /\b401\b|not logged in|unauthorized|access token (is )?expired|authentication (failed|required)|invalid.*(token|auth|credential)|please (log|sign)[ -]?in/.test(
      text,
    )
  ) {
    return { errorClass: 'authentication', retryable: false }
  }
  return { errorClass: 'provider-error', retryable: false }
}
