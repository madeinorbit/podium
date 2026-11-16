/**
 * Acceptance 4 of epic Task 14: the token set never passes through a daemon.
 * The loopback messages carry the callback's query fields and nothing else.
 */

import { describe, expect, it } from 'vitest'
import {
  OauthLoopbackCallbackMessage,
  OauthLoopbackRequestMessage,
  OauthLoopbackResultMessage,
} from './oauth-loopback'

const shapeKeys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort()

describe('oauthLoopback messages (credential management §11)', () => {
  it('the callback carries code, state, the issued client id, the scope or an error, and nothing else', () => {
    expect(shapeKeys(OauthLoopbackCallbackMessage)).toEqual(
      [
        'clientId',
        'code',
        'error',
        'errorDescription',
        'requestId',
        'scope',
        'state',
        'type',
      ].sort(),
    )
    const ok = OauthLoopbackCallbackMessage.safeParse({
      type: 'oauthLoopbackCallback',
      requestId: 'ol1',
      code: 'FAKE-code',
      state: 'FAKE-state',
    })
    expect(ok.success).toBe(true)
  })

  it.each([
    'access_token',
    'refresh_token',
    'id_token',
    'accessToken',
    'refreshToken',
    'idToken',
    'tokens',
  ])('a callback with %s is refused', (key) => {
    const parsed = OauthLoopbackCallbackMessage.safeParse({
      type: 'oauthLoopbackCallback',
      requestId: 'ol1',
      code: 'FAKE-code',
      state: 'FAKE-state',
      [key]: 'FAKE-token-value',
    })
    expect(parsed.success).toBe(false)
  })

  it('the request and its result carry no token field', () => {
    expect(shapeKeys(OauthLoopbackRequestMessage)).toEqual(
      ['path', 'port', 'requestId', 'ttlMs', 'type'].sort(),
    )
    expect(shapeKeys(OauthLoopbackResultMessage)).toEqual(
      ['error', 'listening', 'requestId', 'type'].sort(),
    )
  })

  it('listens only on the callback path OpenAI returns to', () => {
    const base = { type: 'oauthLoopbackRequest', requestId: 'ol1', port: 1455, ttlMs: 600_000 }
    expect(OauthLoopbackRequestMessage.safeParse({ ...base, path: '/auth/callback' }).success).toBe(
      true,
    )
    expect(OauthLoopbackRequestMessage.safeParse({ ...base, path: '/callback' }).success).toBe(
      false,
    )
  })
})
