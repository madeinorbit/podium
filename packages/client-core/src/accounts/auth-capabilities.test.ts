import { afterEach, expect, test, vi } from 'vitest'
import { cookieCredentials, createAuthClient, decideAccount, parseAuthStatus } from './index'

const capabilities = {
  version: 1,
  passwordSignIn: true,
  providers: ['google', 'github'],
  selfSignUp: true,
  invitationDelivery: 'mail',
  passwordReset: 'mail',
  emailVerification: true,
  organisations: true,
  sameMachineSignIn: false,
  adminSignOutEverywhere: false,
  adminEndDeviceSignIn: false,
  accountUrl: 'https://accounts.example/account',
}
afterEach(() => vi.unstubAllGlobals())
test('keeps the server capability list and prompt without projecting an edition', () => {
  const status = parseAuthStatus({
    needsAuth: true,
    authed: false,
    userId: null,
    capabilities,
    prompt: 'email-password',
  })
  expect(status).toMatchObject({ capabilities, prompt: 'email-password' })
  expect(status).not.toHaveProperty('mode')
})
test('refuses an invalid capability list instead of guessing sign-in controls', () => {
  expect(() =>
    parseAuthStatus({
      needsAuth: true,
      authed: false,
      capabilities: { ...capabilities, providers: ['unknown'] },
    }),
  ).toThrow()
})
test('recognises membership denial from the shared identity envelope', () => {
  const status = parseAuthStatus({
    needsAuth: true,
    authed: false,
    userId: null,
    capabilities,
    prompt: 'email-password',
    denied: 'not_workspace_member',
  })
  expect(decideAccount(status)).toMatchObject({
    kind: 'membership-denied',
    reason: 'This account is not a member of this workspace.',
  })
})
test('signs out through the same endpoint without probing an edition', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
  const client = createAuthClient({ credentials: cookieCredentials, fetch })
  await client.logout('https://workspace.example')
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://workspace.example/auth/logout'])
})

test('invalid capabilities cannot fall through to browser offline recovery', async () => {
  const client = createAuthClient({
    credentials: cookieCredentials,
    validateProbeEnvelope: false,
    fetch: async () =>
      Response.json({
        needsAuth: true,
        authed: false,
        capabilities: { ...capabilities, providers: ['unknown'] },
      }),
  })
  expect(await client.probeAuth('https://workspace.example')).toMatchObject({
    kind: 'ready',
    auth: { kind: 'failure', failure: { kind: 'auth-intercepted' } },
  })
})
