import { describe, expect, it } from 'vitest'
import {
  CHECK_ERROR_SENTENCES,
  type CheckResult,
  isCheckUnavailable,
  normalizeCheckResult,
} from './connect-check'

const portRefusal: CheckResult = {
  ok: false,
  error: 'INVALID_URL',
  detail: 'must be on port 443',
}

describe('Connect port compatibility', () => {
  it.each([
    1, 80, 8443, 10000, 18787, 65535,
  ])('treats the deployed port refusal as an unavailable check for HTTPS port %s', (port) => {
    const verdict = normalizeCheckResult(`https://example.com:${port}`, portRefusal)
    expect(verdict).toEqual({ ok: false, error: 'PORT_UNSUPPORTED', detail: '' })
    expect(isCheckUnavailable(verdict)).toBe(true)
    expect(CHECK_ERROR_SENTENCES.PORT_UNSUPPORTED).toContain('could not check this port')
    expect(CHECK_ERROR_SENTENCES.PORT_UNSUPPORTED).not.toMatch(/typo|not a usable URL/)
  })

  it.each([
    'not a url',
    'https://example.com',
    'https://example.com:443',
    'http://example.com:8443',
    'https://example.com:65536',
  ])('does not relabel an invalid URL or the default port: %s', (url) => {
    expect(normalizeCheckResult(url, portRefusal)).toBe(portRefusal)
  })

  it.each<CheckResult>([
    { ok: true, url: 'https://example.com:8443', resolvedTo: [] },
    { ok: false, error: 'INVALID_URL', detail: 'must be a bare origin, no path' },
    { ok: false, error: 'PORT_UNSUPPORTED', detail: 'port is outside the probe allowlist' },
    { ok: false, error: 'PORT_NOT_REACHABLE', detail: 'could not connect' },
    { ok: false, error: 'PRIVATE_ADDRESS', detail: 'private network' },
    { ok: false, error: 'CONNECT_UNAVAILABLE', detail: 'offline' },
  ])('preserves all other probe results: $error', (verdict) => {
    expect(normalizeCheckResult('https://example.com:8443', verdict)).toBe(verdict)
  })

  it('has no reachability opinion only when a check could not run', () => {
    expect(isCheckUnavailable(undefined)).toBe(true)
    expect(isCheckUnavailable({ ok: false, error: 'CONNECT_UNAVAILABLE', detail: '' })).toBe(true)
    expect(isCheckUnavailable({ ok: false, error: 'PORT_UNSUPPORTED', detail: '' })).toBe(true)
    expect(isCheckUnavailable(portRefusal)).toBe(false)
    expect(isCheckUnavailable({ ok: false, error: 'UNREACHABLE', detail: '' })).toBe(false)
    expect(isCheckUnavailable({ ok: true, url: 'https://example.com', resolvedTo: [] })).toBe(false)
  })
})
