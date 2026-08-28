import { describe, expect, it } from 'vitest'
import {
  classifyClaudeSdkFailure,
  formatClaudeSdkResultFailure,
  redactClaudeSdkFailureDetail,
} from './classify.js'

describe('Claude SDK provider failure classification', () => {
  it('classifies monthly spend exhaustion as a non-retryable usage limit', () => {
    expect(classifyClaudeSdkFailure("You've hit your monthly spend limit")).toEqual({
      errorClass: 'usage_limit',
      retryable: false,
    })
    expect(
      classifyClaudeSdkFailure('HTTP 429: rate_limit: You have hit your monthly spend limit'),
    ).toEqual({ errorClass: 'usage_limit', retryable: false })
  })

  it('keeps a transient 429 as retryable rate_limit', () => {
    expect(classifyClaudeSdkFailure('stream error: 429 Too Many Requests')).toEqual({
      errorClass: 'rate_limit',
      retryable: true,
    })
  })

  it('classifies expired or invalid auth as authentication, not usage', () => {
    expect(classifyClaudeSdkFailure('401 Unauthorized — access token is expired')).toEqual({
      errorClass: 'authentication',
      retryable: false,
    })
    expect(classifyClaudeSdkFailure('invalid OAuth token; please log in')).toEqual({
      errorClass: 'authentication',
      retryable: false,
    })
    expect(classifyClaudeSdkFailure('not logged in — run /login')).toEqual({
      errorClass: 'authentication',
      retryable: false,
    })
  })

  it('keeps monthly-spend and auth text from SDKResultError.errors, redacted', () => {
    const spend = formatClaudeSdkResultFailure({
      subtype: 'error_during_execution',
      errors: ["You've hit your monthly spend limit CLAUDE_CODE_OAUTH_TOKEN=oat_secret"],
    })
    expect(spend).toMatch(/monthly spend limit/i)
    expect(spend).toMatch(/error_during_execution/)
    expect(spend).not.toMatch(/oat_secret/)
    expect(classifyClaudeSdkFailure(spend).errorClass).toBe('usage_limit')

    const expired = formatClaudeSdkResultFailure({
      subtype: 'error_during_execution',
      errors: ['401 Unauthorized — access token is expired'],
    })
    expect(classifyClaudeSdkFailure(expired).errorClass).toBe('authentication')
    expect(formatClaudeSdkResultFailure({ subtype: 'error_during_execution', errors: [] })).toBe(
      'claude turn failed: error_during_execution',
    )
  })

  it('never copies credential material into stored detail', () => {
    const leaked =
      '401 Unauthorized for CLAUDE_CODE_OAUTH_TOKEN=oat_secretvalue sk-ant-secretkey Bearer abc.def'
    const redacted = redactClaudeSdkFailureDetail(leaked)
    expect(redacted).not.toMatch(/oat_secretvalue|sk-ant-secretkey|abc\.def/)
    expect(redacted).toContain('[redacted]')
    expect(classifyClaudeSdkFailure(leaked).errorClass).toBe('authentication')
  })
})
